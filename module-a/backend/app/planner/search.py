from __future__ import annotations
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import datetime, time, timedelta, timezone
from app.errors import AppError
from app.goals import required_goals, covered, sequence_progress
from app.schemas import CampaignStop, Place, Point, Preferences, WalkingLeg

CST = timezone(timedelta(hours=8))
INTEREST_LABELS = {"coffee": "咖啡", "food": "美食", "landmark": "地标", "launch": "首发",
                   "culture": "文化", "lifestyle": "逛店", "hotpot": "火锅", "tea": "茶饮", "photo": "拍照", "local": "本地风味"}


@dataclass
class State:
    last: str
    at: datetime
    selected: tuple = ()
    stops: list = field(default_factory=list)
    legs: list = field(default_factory=list)
    cost_min: int = 0
    cost_max: int = 0
    distance: int = 0
    walk: int = 0
    wait: int = 0
    queue: int = 0
    dwell: int = 0
    score: float = 0


def leg_between(origin, target, graph, places, at):
    if origin == target:
        p = places[origin]
        return WalkingLeg(from_place_id=origin, to_place_id=target, distance_m=0, duration_s=0,
            points=[Point(longitude=p.longitude, latitude=p.latitude)], source="same_location",
            retrieved_at=at, entrance_version=f"{p.entrance_version}:{p.entrance_version}")
    return graph.get((origin, target))


def schedule(arrival, stop):
    # No assumed overnight openings: each configured window is same-day.
    for window in sorted(stop.windows, key=lambda w: w.opens):
        opens = datetime.combine(arrival.date(), time.fromisoformat(window.opens), CST)
        closes = datetime.combine(arrival.date(), time.fromisoformat(window.closes), CST)
        ready = max(arrival, opens)
        experience = ready + timedelta(seconds=stop.queue_s)
        departure = experience + timedelta(seconds=stop.dwell_s)
        if departure <= closes:
            return ready, experience, departure
    return None


def search_routes(preferences: Preferences, places_list: list[Place], stops_list: list[CampaignStop], graph, *, include_options=False, max_stops=5, allow_empty=False):
    places = {p.place_id: p for p in places_list}
    p = preferences
    for place_id in [p.start_place_id, *([p.end_place_id] if p.end_place_id else []),
                     *p.must_visit_ids, *p.excluded_place_ids]:
        if place_id not in places:
            raise AppError("INVALID_INPUT", "存在未知地点 ID。", 422, {"place_id": place_id})
    stops_by_place = {stop.place_id: stop for stop in stops_list}
    missing_required = [pid for pid in p.must_visit_ids if pid not in stops_by_place]
    if missing_required:
        raise AppError("NO_FEASIBLE_ROUTE", "必去地点没有可参与的演示活动。", 422,
                       {"unavailable_required": missing_required})
    candidates = [s for s in stops_list if s.place_id in places and s.place_id not in p.excluded_place_ids
                  and s.status == "open" and s.queue_s <= p.max_queue_s
                  and not (set(s.interests) & set(p.excluded_interests))]
    if not set(p.must_visit_ids) <= {s.place_id for s in candidates}:
        raise AppError("NO_FEASIBLE_ROUTE", "必去地点关闭、排队超过上限或与排除偏好冲突。", 422,
                       {"suggestions": ["放宽排队上限", "调整必去地点"]})
    goals = required_goals(p)
    required_experiences = set(p.required_experiences)
    available_experiences = {tag for stop in candidates for tag in stop.interests}
    missing_experiences = required_experiences - available_experiences
    if missing_experiences:
        raise AppError("NO_FEASIBLE_ROUTE", "当前条件下无法安排"+"、".join(INTEREST_LABELS.get(tag,tag) for tag in sorted(missing_experiences))+"，请调整条件或更换体验。", 422,
                       {"missing_required_experiences": sorted(missing_experiences),
                        "suggestions": ["放宽排队上限", "更换体验或补充候选门店"]})
    for goal in goals + p.visit_sequence:
        if not covered(goal,candidates):
            raise AppError("NO_FEASIBLE_ROUTE", "当前候选无法满足指定体验或顺序目标。",422,
                           {"unsatisfied_goal":goal.model_dump(),"suggestions":["调整条件或补充候选"]})
    departure = p.departure_at.astimezone(CST)
    deadline = departure + timedelta(seconds=p.max_duration_s)
    rejects = Counter()
    beam = [State(last=p.start_place_id, at=departure)]
    results = []
    required = set(p.must_visit_ids)
    for depth in range(min(max_stops, len(candidates))):
        extended = []
        for state in beam:
            for stop in candidates:
                if stop.place_id in state.selected:
                    continue
                categories=[stops_by_place[pid].category for pid in state.selected]
                if any((sum(category in {'coffee','tea'} if key=='drink' else category==key for category in categories)
                        >= limit) for key,limit in p.category_limits.items()
                       if (stop.category in {'coffee','tea'} if key=='drink' else stop.category==key)):
                    rejects['category_limit'] += 1
                    continue
                selected_stops=[stops_by_place[pid] for pid in (*state.selected,stop.place_id)]
                if sequence_progress(p.visit_sequence,selected_stops)<0:
                    rejects["visit_order"] += 1
                    continue
                leg = leg_between(state.last, stop.place_id, graph, places, state.at)
                if leg is None:
                    rejects["missing_walking_leg"] += 1
                    continue
                if state.distance + leg.distance_m > p.max_walk_m:
                    rejects["walk_limit"] += 1
                    continue
                if state.cost_max + stop.cost_max_fen > p.budget_per_person_fen:
                    rejects["budget_limit"] += 1
                    continue
                arrival = state.at + timedelta(seconds=leg.duration_s)
                times = schedule(arrival, stop)
                if times is None:
                    rejects["closed_or_activity_ended"] += 1
                    continue
                ready, experience, leave = times
                wait = int((ready-arrival).total_seconds())
                if leave + timedelta(seconds=p.buffer_s) > deadline:
                    rejects["time_limit"] += 1
                    continue
                matching = sorted(set(stop.interests) & set(p.interests))
                goal_tags={tag for goal in goals+p.visit_sequence for tag in goal.any_of}
                required_matching = sorted(set(stop.interests) & goal_tags)
                prior_interests = {tag for pid in state.selected for tag in stops_by_place[pid].interests}
                novelty = len(set(matching)-prior_interests) / max(1, len(set(p.interests)))
                diversity = stop.category not in {stops_by_place[pid].category for pid in state.selected}
                # Demo benefits are shown with conditions, not counted as guaranteed savings.
                increment = 0.16 + 0.40*novelty + 0.15*diversity - 0.15*leg.distance_m/max(p.max_walk_m, 1) - 0.10*stop.queue_s/max(p.max_duration_s, 1)
                place = places[stop.place_id]
                labels={**INTEREST_LABELS,**stop.experience_labels}
                row = {"stop_id": stop.stop_id, "place_id": stop.place_id, "name": place.name,
                       "category": stop.category, "activity_title": stop.title,
                       "arrival_at": arrival.isoformat(), "experience_start_at": experience.isoformat(),
                       "departure_at": leave.isoformat(), "walk_duration_s": leg.duration_s,
                       "wait_duration_s": wait, "queue_duration_s": stop.queue_s, "dwell_duration_s": stop.dwell_s,
                       "cost_min_per_person_fen": stop.cost_min_fen, "cost_max_per_person_fen": stop.cost_max_fen,
                       "benefits": [b.model_dump(mode="json") for b in stop.benefits],
                       "verification": "not_visited", "matched_interests": matching,
                       "matched_required_experiences": required_matching,
                       "recommendation": ("满足核心需求："+"、".join(labels.get(tag,tag) for tag in required_matching)) if required_matching else (("符合偏好："+"、".join(labels.get(tag, tag) for tag in matching)) if matching else "补充沿途体验"),
                       "sources": {"location": place.location_source, "campaign": "demo", "queue": "demo", "cost": "demo"}}
                new = State(last=stop.place_id, at=leave, selected=(*state.selected, stop.place_id),
                    stops=[*state.stops, row], legs=[*state.legs, leg],
                    cost_min=state.cost_min+stop.cost_min_fen, cost_max=state.cost_max+stop.cost_max_fen,
                    distance=state.distance+leg.distance_m, walk=state.walk+leg.duration_s,
                    wait=state.wait+wait, queue=state.queue+stop.queue_s, dwell=state.dwell+stop.dwell_s,
                    score=state.score+increment)
                extended.append(new)
                fulfilled = {tag for pid in new.selected for tag in stops_by_place[pid].interests}
                if (not required <= set(new.selected) or not all(covered(goal,selected_stops) for goal in goals)
                        or sequence_progress(p.visit_sequence,selected_stops)!=len(p.visit_sequence)):
                    continue
                final = new
                if p.end_place_id:
                    return_leg = leg_between(new.last, p.end_place_id, graph, places, new.at)
                    if return_leg is None:
                        rejects["missing_return_leg"] += 1
                        continue
                    final = replace(new, at=new.at+timedelta(seconds=return_leg.duration_s),
                        legs=[*new.legs, return_leg], distance=new.distance+return_leg.distance_m,
                        walk=new.walk+return_leg.duration_s,
                        score=new.score-0.15*return_leg.distance_m/max(p.max_walk_m, 1))
                if final.at+timedelta(seconds=p.buffer_s) <= deadline and final.distance <= p.max_walk_m:
                    results.append(final)
                else:
                    rejects["return_or_buffer_limit"] += 1
        def beam_rank(state):
            fulfilled = {tag for pid in state.selected for tag in stops_by_place[pid].interests}
            selected_stops=[stops_by_place[pid] for pid in state.selected]
            progress=sum(covered(goal,selected_stops) for goal in goals)+sequence_progress(p.visit_sequence,selected_stops)
            return (-len(required & set(state.selected)), -progress, -state.score, state.at, state.selected)
        beam = sorted(extended, key=beam_rank)[:32]
        if not beam:
            break
    if not results and allow_empty and not required and not goals and not p.visit_sequence:
        terminal = State(last=p.start_place_id, at=departure)
        if p.end_place_id and p.end_place_id != p.start_place_id:
            back = leg_between(p.start_place_id, p.end_place_id, graph, places, departure)
            if back:
                terminal = replace(terminal, at=departure+timedelta(seconds=back.duration_s),
                                   legs=[back], walk=back.duration_s, distance=back.distance_m)
            else:
                rejects["missing_return_leg"] += 1
                terminal = None
        buffer = p.buffer_s if terminal and terminal.legs else 0
        if terminal and terminal.at+timedelta(seconds=buffer) <= deadline and terminal.distance <= p.max_walk_m:
            terminal_preferences = p.model_copy(update={"buffer_s": buffer})
            plan = render_plan(terminal, terminal_preferences, departure, rejects)
            plan["planning_outcome"] = "return_only" if terminal.legs else "completed"
            plan["notice"] = "剩余时间仅安排返程。" if terminal.legs else "行程已完成，没有继续添加站点。"
            if include_options:
                return {"options": [{"option_id": "balanced", "title": plan["notice"], "recommended": True, **plan}],
                        "recommended_id": "balanced", "shared_walking_graph": True, "notice": plan["notice"]}
            return plan
    if not results:
        raise AppError("NO_FEASIBLE_ROUTE", "在当前时间、预算与点位条件下没有可执行路线。", 422,
                       {"conflicts": dict(rejects), "required_experiences": sorted(required_experiences), "suggestions": ["增加可用时间", "提高预算或减少必去点", "调整出发时段"]})
    def coverage(state):
        return len({tag for pid in state.selected for tag in stops_by_place[pid].interests} & set(p.interests))

    def rank(state, style):
        if style == "less_walking":
            return (-state.distance, -state.walk, coverage(state), state.score)
        if style == "more_experiences":
            categories = len({stops_by_place[pid].category for pid in state.selected})
            return (coverage(state), categories, len(state.selected), state.score, -state.walk)
        return (state.score, len(state.selected), -state.walk)

    comparable = results
    if p.visit_mode == "focused":
        fewest_stops = min(len(state.selected) for state in results)
        comparable = [state for state in results if len(state.selected) == fewest_stops]
    if not include_options:
        best = max(comparable, key=lambda s: rank(s, p.planning_style))
        return render_plan(best, p, departure, rejects)
    chosen = []
    styles=[("balanced","综合推荐"),("less_walking","少走一点"),("more_experiences","多逛几站")]
    styles.sort(key=lambda item:item[0]!=p.planning_style)
    for style, title in styles:
        best = max(comparable, key=lambda s: rank(s, style))
        if any(set(best.selected) == set(state.selected) for _, _, state in chosen):
            continue
        chosen.append((style, title, best))
    options = []
    for style, title, state in chosen:
        option_preferences = p.model_copy(update={"planning_style": style})
        plan = render_plan(state, option_preferences, departure, rejects)
        options.append({"option_id": style, "title": title, "recommended": style == p.planning_style, **plan})
    return {"options": options, "recommended_id": p.planning_style, "shared_walking_graph": True,
            "notice": "最多提供三条不同点位组合的可行方案；不足时只返回实际有差异的方案。"}


def render_plan(best, p, departure, rejects):
    end = best.at+timedelta(seconds=p.buffer_s)
    return {"preferences": p.model_dump(mode="json"), "departure_at": departure.isoformat(),
            "planned_end_at": end.isoformat(), "stop_ids": [s["stop_id"] for s in best.stops],
            "stops": best.stops, "legs": [leg.model_dump(mode="json") for leg in best.legs],
            "totals": {"walk_duration_s": best.walk, "wait_duration_s": best.wait,
                "queue_duration_s": best.queue, "dwell_duration_s": best.dwell, "buffer_s": p.buffer_s,
                "duration_s": int((end-departure).total_seconds()), "walk_distance_m": best.distance,
                "cost_min_per_person_fen": best.cost_min, "cost_max_per_person_fen": best.cost_max},
            "sources": {"location": "baidu_place_v3", "path": "baidu_walking", "campaign": "demo", "queue": "demo", "inventory": "demo"},
            "warnings": ["活动、排队、停留与消费区间为演示配置；不代表商户承诺。", "地图 POI 尚未人工确认入口；不包含商场内部楼层导航。"],
            "planner": {"algorithm": "bounded_beam_search", "beam_width": 32, "max_stops": 5,
                        "score": round(best.score, 4), "rejections": dict(rejects)}}
