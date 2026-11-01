"""Validated business tools, ready for a future agent to call.

Tool execution is shared by validated language parsing and direct API calls.
All tools are read/compute-only and cannot save routes or issue rewards.
"""
import asyncio
import heapq
import time
from datetime import datetime, timezone
from pathlib import Path
from pydantic import ValidationError
from app.errors import AppError
from app.planner.search import search_routes
from app.schemas import NearbyArguments, PlaceDetailsArguments, Preferences, Place, Point
from app.maps.nearby import distance_m
from app.catalog import CatalogIndex
from app.goals import required_goals, matches, covered, vocabulary_tags


class BusinessTools:
    INPUTS = {
        "get_place_details": (PlaceDetailsArguments, "查询商家地址、位置、活动时段、排队和福利；客流未知时明确返回未知。"),
        "search_nearby_places": (NearbyArguments, "用统一坐标召回附近点位，返回近似距离；实际步行时间需规划工具计算。"),
        "plan_route_options": (Preferences, "基于真实步行路段生成最多三种不同可行方案，推荐综合方案；不保存或开始行程。"),
    }

    def __init__(self, database, stops, segments, nearby, campaign_path):
        self.database, self.stops, self.segments, self.nearby = database, stops, segments, nearby
        self.dynamic = None
        self._catalog = None
        self._catalog_key = None
        self.configured_at = datetime.fromtimestamp(Path(campaign_path).stat().st_mtime, timezone.utc).isoformat()

    @classmethod
    def specifications(cls):
        return [{"name": name, "description": description,
                 "input_schema": schema.model_json_schema(), "side_effects": "none"}
                for name, (schema, description) in cls.INPUTS.items()]

    def catalog(self):
        key=(self.database.catalog_revision,id(self.stops),len(self.stops))
        if self._catalog_key!=key:
            self._catalog=CatalogIndex(self.database.places(),self.stops)
            self._catalog_key=key
        return self._catalog

    def effective_stops(self, token=None, ids=None, snapshot=None):
        snapshot = snapshot if snapshot is not None else self.dynamic.snapshot(token) if token and self.dynamic else {"state_version":1,"states":{},"position_revision":0,"position":None}
        stops = []
        catalog=self.catalog()
        for stop in (catalog.stops.values() if ids is None else (catalog.stops[pid] for pid in ids if pid in catalog.stops)):
            change = snapshot["states"].get(stop.place_id, {})
            if not change:
                stops.append(stop)
                continue
            data = stop.model_dump(mode="json")
            for key in ("queue_s", "status"):
                if key in change: data[key] = change[key]
            if "inventory_status" in change:
                for benefit in data["benefits"]: benefit["inventory_status"] = change["inventory_status"]
            stops.append(type(stop).model_validate(data))
        return stops, snapshot

    def place_details(self, place_id, token=None):
        place = self.catalog().places.get(place_id)
        if place is None:
            raise AppError("RESOURCE_NOT_FOUND", "地点不存在。", 404)
        effective, snapshot = self.effective_stops(token, {place_id})
        state_timestamp = snapshot["states"].get(place_id, {}).get("updated_at",self.configured_at)
        stop = next((s for s in effective if s.place_id == place_id), None)
        activity = stop.model_dump(mode="json") if stop else None
        return {"place": place.model_dump(mode="json"), "activity": activity, "state_version":snapshot["state_version"],
                "crowd_density": {"value": None, "unit": None, "source": "unavailable",
                                  "reason": "尚无商户或客流服务接入，不从排队或坐标推测人数密度。"},
                "queue": {"duration_s": stop.queue_s if stop else None,
                          "source": "demo" if stop else "unavailable", "configured_at": state_timestamp},
                "opening_status": {"value": stop.status if stop else "unknown",
                                   "source": "demo" if stop else "unavailable", "configured_at": state_timestamp},
                "notice": "位置来自"+("百度" if place.location_source=="baidu_place_v3" else "合作目录")+"；活动、营业与排队为演示配置，未提供实时人数密度。"}

    async def plan(self, preferences, include_options=False, token=None, max_stops=5, completed_categories=None, allow_empty=False, completed_place_ids=None):
        try:
            async with asyncio.timeout(20):
                return await self._plan(preferences, include_options, token, max_stops, completed_categories, allow_empty, completed_place_ids)
        except TimeoutError:
            raise AppError("UPSTREAM_TIMEOUT", "步行路线计算超时，请重试；当前行程仍保留。", 504) from None

    async def _plan(self, preferences, include_options, token, max_stops, completed_categories, allow_empty, completed_place_ids):
        started=time.perf_counter()
        requested_preferences = preferences.model_dump(mode="json")
        catalog=self.catalog()
        by_id=catalog.places
        if not by_id: raise AppError("MAP_UNAVAILABLE","尚未准备点位。",503)
        goals=required_goals(preferences)+preferences.visit_sequence
        referenced=[preferences.start_place_id,preferences.end_place_id,*preferences.must_visit_ids,*preferences.excluded_place_ids,
                    *(pid for goal in goals for pid in goal.place_ids)]
        unknown=[pid for pid in referenced if pid and pid not in by_id]
        if unknown:raise AppError("INVALID_INPUT","请求中包含未知地点。",422,{"place_ids":unknown})
        unknown_tags=vocabulary_tags(preferences)-set(catalog.vocabulary)
        if unknown_tags:
            raise AppError("UNSUPPORTED_EXPERIENCE","目录尚无这些体验的可靠标签，请补充商家数据或调整需求。",422,{"tags":sorted(unknown_tags)})
        snapshot=self.dynamic.snapshot(token) if token and self.dynamic else {"state_version":1,"states":{},"position_revision":0,"position":None}
        position=snapshot.get('position') if preferences.use_current_position else None
        if preferences.use_current_position:
            if not position:raise AppError("POSITION_REQUIRED","请先上报或确认用户当前位置。",422)
            age=(datetime.now(timezone.utc)-datetime.fromisoformat(position['observed_at'])).total_seconds()
            if age>120 or age< -10:raise AppError("STALE_POSITION","当前位置已过期，请重新定位。",422)
        anchor=Point(longitude=position['longitude'],latitude=position['latitude']) if position else by_id[preferences.start_place_id]
        scope=catalog.nearby_ids(anchor,preferences.max_walk_m)
        scope.update(preferences.must_visit_ids)
        scope.update(pid for goal in goals for pid in goal.place_ids)
        effective_stops,_=self.effective_stops(token,scope,snapshot=snapshot)
        remaining_limits=dict(preferences.category_limits)
        for key,limit_value in remaining_limits.items():
            consumed=sum(category in {'coffee','tea'} if key=='drink' else category==key for category in (completed_categories or []))
            remaining_limits[key]=max(0,limit_value-consumed)
        preferences=preferences.model_copy(update={'category_limits':remaining_limits})
        effective_stops=[stop for stop in effective_stops if stop.place_id not in set(completed_place_ids or []) and all(
            limit_value>0 for key,limit_value in remaining_limits.items()
            if (stop.category in {'coffee','tea'} if key=='drink' else stop.category==key))]
        excluded=set(preferences.excluded_place_ids)
        excluded_tags=set(preferences.excluded_interests)
        eligible=[stop for stop in effective_stops if stop.place_id not in excluded and stop.status=='open'
                  and stop.queue_s<=preferences.max_queue_s and stop.cost_max_fen<=preferences.budget_per_person_fen
                  and not set(stop.interests)&excluded_tags
                  and stop.dwell_s+stop.queue_s+preferences.buffer_s<=preferences.max_duration_s]
        missing_goals=[goal for goal in goals if not covered(goal,eligible)]
        if missing_goals:
            relevant=[stop for stop in effective_stops if any(matches(goal,stop) for goal in missing_goals)]
            reasons={'closed':sum(stop.status!='open' for stop in relevant),
                     'queue_limit':sum(stop.queue_s>preferences.max_queue_s for stop in relevant),
                     'budget_limit':sum(stop.cost_max_fen>preferences.budget_per_person_fen for stop in relevant),
                     'excluded':sum(stop.place_id in excluded or bool(set(stop.interests)&excluded_tags) for stop in relevant),
                     'time_limit':sum(stop.dwell_s+stop.queue_s+preferences.buffer_s>preferences.max_duration_s for stop in relevant)}
            reasons_text={'closed':'候选未营业','queue_limit':'排队超过上限','budget_limit':'预算不足','excluded':'候选已被排除','time_limit':'可用时间不足'}
            labels='、'.join(catalog.labels.get(tag,tag) for goal in missing_goals for tag in goal.any_of) or '必去地点'
            reason='、'.join(reasons_text[key] for key,value in reasons.items() if value) or '步行范围内没有可用候选'
            raise AppError('NO_FEASIBLE_ROUTE','无法安排'+labels+'：'+reason+'。请调整条件或补充候选门店。',422,
                {'missing_goals':[g.model_dump() for g in missing_goals],
                 'missing_required_experiences':sorted({tag for g in missing_goals for tag in g.any_of}&set(preferences.required_experiences)),
                 'conflicts':reasons,'suggestions':['调整时间、预算或排队上限','更换体验或补充候选']})
        selected=set(preferences.must_visit_ids)
        distances={stop.place_id:distance_m(anchor,by_id[stop.place_id]) for stop in eligible}
        nearest=lambda stop:(distances[stop.place_id],stop.place_id)
        alternatives=[]
        for goal in goals:
            choices=heapq.nsmallest(2,(stop for stop in eligible if matches(goal,stop)),key=nearest)
            if choices:selected.add(choices[0].place_id)
            alternatives.extend(choices[1:])
        limit=max(8,len(selected))
        for stop in alternatives:
            if len(selected)<limit:selected.add(stop.place_id)
        def recall_rank(stop):return (-len(set(stop.interests)&set(preferences.interests)),*nearest(stop))
        fillers=(stop for stop in eligible if preferences.visit_mode!='focused' or not goals or any(matches(g,stop) for g in goals))
        for stop in heapq.nsmallest(limit,fillers,key=recall_rank):
            if len(selected)>=limit:break
            selected.add(stop.place_id)
        if max_stops==0:selected=set()
        candidate_count=len(eligible)
        effective_stops=[stop for stop in effective_stops if stop.place_id in selected]
        endpoint_ids={preferences.start_place_id,preferences.end_place_id}-{None}
        reference=None
        if position:
            close=catalog.nearby_ids(anchor,1)
            reference=min((by_id[pid] for pid in close),key=lambda p:distance_m(anchor,p),default=None)
            if reference:endpoint_ids.add(reference.place_id)
        points=[by_id[pid] for pid in sorted(selected|endpoint_ids)]
        recall_ms=round((time.perf_counter()-started)*1000,2)
        # A focused one-stop task needs a star, not all candidate-to-candidate roads.
        single_stop=(preferences.visit_mode=='focused' and len(preferences.visit_sequence)<=1
                     and all(all(matches(goal,stop) for goal in goals) for stop in effective_stops)
                     and len(preferences.must_visit_ids)<=1)
        if single_stop:
            start_id=reference.place_id if reference else preferences.start_place_id
            edges=[(start_id,pid) for pid in sorted(selected)]
            if preferences.end_place_id:edges.extend((pid,preferences.end_place_id) for pid in sorted(selected))
            if preferences.end_place_id:edges.append((start_id,preferences.end_place_id))
            graph,failures=await self.segments.graph(points,edges=edges)
        else:
            # Prioritize departure legs under the cold-cache budget.
            points.sort(key=lambda p:(p.place_id!=(reference.place_id if reference else preferences.start_place_id),p.place_id))
            graph,failures=await self.segments.graph(points)
        origin = None
        if preferences.use_current_position:
            position = snapshot.get('position')
            if not position:
                raise AppError('POSITION_REQUIRED','请先上报或确认用户当前位置。',422)
            age=(datetime.now(timezone.utc)-datetime.fromisoformat(position['observed_at'])).total_seconds()
            if age>120 or age< -10:
                raise AppError('STALE_POSITION','当前位置已过期，请重新定位。',422)
            exact_distance=distance_m(anchor,reference) if reference else float('inf')
            if exact_distance<=1:
                origin_place=reference
                reused_place=reference.place_id
            else:
                origin_place=Place(place_id='user_position',name='用户当前位置',address='',uid='user_position',
                    category='start',longitude=position['longitude'],latitude=position['latitude'],
                    location_source='user_location',retrieved_at=datetime.fromisoformat(position['observed_at']))
                reused_place=None
                if self.segments.mode!='baidu':
                    raise AppError('MAP_UNAVAILABLE','当前位置缺少已准备路段，需要实时步行服务。',503)
                # Exact user coordinates are not written into the shared place/segment cache.
                targets=[p for p in points if p.place_id in selected or p.place_id==preferences.end_place_id]
                for target in targets:
                    try:
                        graph[(origin_place.place_id,target.place_id)]=await self.segments.get_from_position(origin_place,target)
                    except AppError as error:
                        failures.append({'from_place_id':origin_place.place_id,'to_place_id':target.place_id,'code':error.code,'details':error.details})
                points=[*points,origin_place]
            preferences=preferences.model_copy(update={'start_place_id':origin_place.place_id})
            origin={'longitude':position['longitude'],'latitude':position['latitude'],'coord_system':'gcj02',
                    'accuracy_m':position['accuracy_m'],'observed_at':position['observed_at'],
                    'source':position['source'],'position_revision':snapshot['position_revision'],
                    'reused_place_id':reused_place,'reuse_offset_m':round(exact_distance,2) if reused_place else None}

        try:
            search_points = [by_id[pid] for pid in sorted(set(referenced)-{None} | selected | endpoint_ids)]
            if origin and origin_place.place_id not in by_id: search_points.append(origin_place)
            result = search_routes(preferences, search_points, effective_stops, graph, include_options=include_options, max_stops=max_stops, allow_empty=allow_empty)
        except AppError as error:
            unavailable = [failure for failure in failures if failure["code"] != "WALKING_UNREACHABLE"]
            if error.code == "NO_FEASIBLE_ROUTE" and unavailable and any(
                    error.details.get("conflicts", {}).get(code) for code in ("missing_walking_leg", "missing_return_leg")):
                raise AppError("MAP_UNAVAILABLE", "缺少必要步行路段，暂时无法验证行程。", 503,
                               {"unavailable_segments": len(unavailable)}) from None
            raise
        if self.catalog().version!=catalog.version:
            raise AppError('STALE_PROPOSAL','计算期间地点目录变化，请重试。',409)
        if token and self.dynamic:
            latest=self.dynamic.snapshot(token)
            if any(latest[key]!=snapshot[key] for key in ('state_version','position_revision')):
                raise AppError('STALE_PROPOSAL','计算期间位置或商家状态变化，请重新规划。',409)
        plans = result["options"] if include_options else [result]
        for plan in plans:
            plan["preferences"] = {**requested_preferences, "planning_style": plan["preferences"]["planning_style"]}
            plan["catalog_version"] = catalog.version
            plan["state_version"] = snapshot["state_version"]
            plan["position_revision"] = snapshot["position_revision"]
            plan["origin"] = origin
            used_sources={by_id[stop["place_id"]].location_source for stop in plan["stops"]}
            plan["sources"]["location"] = next(iter(used_sources)) if len(used_sources)==1 else "mixed_catalog"
            plan["planner"].update(max_stops=max_stops, candidate_limit=limit, candidate_count=len(effective_stops), catalog_eligible_count=candidate_count, recall_ms=recall_ms, elapsed_ms=round((time.perf_counter()-started)*1000,2))
            if candidate_count > len(effective_stops):
                plan["warnings"].append("仅评估召回的有限候选，不承诺全商圈全局最优。")
        if include_options: result["origin"] = origin
        if failures:
            for plan in plans:
                plan["warnings"].append(f"有 {len(failures)} 条路段暂不可用，本路线仅使用已验证路段。")
        return result

    async def call(self, name, arguments, token=None):
        if name not in self.INPUTS:
            raise AppError("INVALID_INPUT", "未知或未授权工具。")
        schema, _ = self.INPUTS[name]
        try:
            parsed = schema.model_validate(arguments)
        except ValidationError as error:
            raise AppError("INVALID_INPUT", "工具参数不符合要求。", 422,
                {"fields": [{"location": list(row["loc"]), "type": row["type"]} for row in error.errors()]}) from None
        if name == "get_place_details":
            return self.place_details(parsed.place_id, token)
        if name == "search_nearby_places":
            return self.nearby.find(parsed, parsed.radius_m, parsed.category, interest=parsed.interest, limit=parsed.limit, catalog=self.catalog())
        return await self.plan(parsed, include_options=True, token=token)
