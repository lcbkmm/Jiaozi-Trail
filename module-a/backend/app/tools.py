"""Validated business tools, ready for a future agent to call.

Tool execution is shared by validated language parsing and direct API calls.
All tools are read/compute-only and cannot save routes or issue rewards.
"""
from datetime import datetime, timezone
from pathlib import Path
from pydantic import ValidationError
from app.errors import AppError
from app.planner.search import search_routes
from app.schemas import NearbyArguments, PlaceDetailsArguments, Preferences, Place, Point
from app.maps.nearby import distance_m


class BusinessTools:
    INPUTS = {
        "get_place_details": (PlaceDetailsArguments, "查询商家地址、位置、活动时段、排队和福利；客流未知时明确返回未知。"),
        "search_nearby_places": (NearbyArguments, "用统一坐标召回附近点位，返回近似距离；实际步行时间需规划工具计算。"),
        "plan_route_options": (Preferences, "基于真实步行路段生成最多三种不同可行方案，推荐综合方案；不保存或开始行程。"),
    }

    def __init__(self, database, stops, segments, nearby, campaign_path):
        self.database, self.stops, self.segments, self.nearby = database, stops, segments, nearby
        self.dynamic = None
        self.configured_at = datetime.fromtimestamp(Path(campaign_path).stat().st_mtime, timezone.utc).isoformat()

    @classmethod
    def specifications(cls):
        return [{"name": name, "description": description,
                 "input_schema": schema.model_json_schema(), "side_effects": "none"}
                for name, (schema, description) in cls.INPUTS.items()]

    def effective_stops(self, token=None):
        snapshot = self.dynamic.snapshot(token) if token and self.dynamic else {"state_version":1,"states":{},"position_revision":0,"position":None}
        stops = []
        for stop in self.stops:
            data = stop.model_dump(mode="json")
            change = snapshot["states"].get(stop.place_id, {})
            for key in ("queue_s", "status"):
                if key in change: data[key] = change[key]
            if "inventory_status" in change:
                for benefit in data["benefits"]: benefit["inventory_status"] = change["inventory_status"]
            stops.append(type(stop).model_validate(data))
        return stops, snapshot

    def place_details(self, place_id, token=None):
        place = next((p for p in self.database.places() if p.place_id == place_id), None)
        if place is None:
            raise AppError("RESOURCE_NOT_FOUND", "地点不存在。", 404)
        effective, snapshot = self.effective_stops(token)
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
                "notice": "位置来自百度；活动、营业与排队为演示配置，未提供实时人数密度。"}

    async def plan(self, preferences, include_options=False, token=None, max_stops=5, completed_categories=None):
        requested_preferences = preferences.model_dump(mode="json")
        effective_stops, snapshot = self.effective_stops(token)
        forbidden = set()
        if "meal" in (completed_categories or []): forbidden.add("meal")
        if {"coffee","tea"} & set(completed_categories or []): forbidden.update({"coffee","tea"})
        effective_stops = [s for s in effective_stops if s.category not in forbidden]
        points = self.database.places()
        by_id = {p.place_id: p for p in points}
        unknown = [pid for pid in [preferences.start_place_id, preferences.end_place_id,
                   *preferences.must_visit_ids, *preferences.excluded_place_ids] if pid and pid not in by_id]
        if unknown:
            raise AppError("INVALID_INPUT", "请求中包含未知地点。", 422, {"place_ids": unknown})
        if not points:
            raise AppError("MAP_UNAVAILABLE", "尚未准备点位。", 503)
        graph, failures = await self.segments.graph(points)
        origin = None
        if preferences.use_current_position:
            position = snapshot.get('position')
            if not position:
                raise AppError('POSITION_REQUIRED','请先上报或确认用户当前位置。',422)
            age=(datetime.now(timezone.utc)-datetime.fromisoformat(position['observed_at'])).total_seconds()
            if age>120 or age< -10:
                raise AppError('STALE_POSITION','当前位置已过期，请重新定位。',422)
            reference=min(points,key=lambda p:distance_m(Point(longitude=position['longitude'],latitude=position['latitude']),p))
            exact_distance=distance_m(Point(longitude=position['longitude'],latitude=position['latitude']),reference)
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
                targets=[p for p in points if p.place_id not in preferences.excluded_place_ids]
                for target in targets:
                    try:
                        graph[(origin_place.place_id,target.place_id)]=await self.segments.provider.walking(origin_place,target)
                    except AppError as error:
                        failures.append({'from_place_id':origin_place.place_id,'to_place_id':target.place_id,'code':error.code,'details':error.details})
                points=[*points,origin_place]
            preferences=preferences.model_copy(update={'start_place_id':origin_place.place_id})
            origin={'longitude':position['longitude'],'latitude':position['latitude'],'coord_system':'gcj02',
                    'accuracy_m':position['accuracy_m'],'observed_at':position['observed_at'],
                    'source':position['source'],'position_revision':snapshot['position_revision'],
                    'reused_place_id':reused_place,'reuse_offset_m':round(exact_distance,2) if reused_place else None}

        try:
            result = search_routes(preferences, points, effective_stops, graph, include_options=include_options, max_stops=max_stops)
        except AppError as error:
            unavailable = [failure for failure in failures if failure["code"] != "WALKING_UNREACHABLE"]
            if error.code == "NO_FEASIBLE_ROUTE" and unavailable and any(
                    error.details.get("conflicts", {}).get(code) for code in ("missing_walking_leg", "missing_return_leg")):
                raise AppError("MAP_UNAVAILABLE", "缺少必要步行路段，暂时无法验证行程。", 503,
                               {"unavailable_segments": len(unavailable)}) from None
            raise
        plans = result["options"] if include_options else [result]
        for plan in plans:
            plan["preferences"] = requested_preferences
            plan["state_version"] = snapshot["state_version"]
            plan["position_revision"] = snapshot["position_revision"]
            plan["origin"] = origin
            used_sources={by_id[stop["place_id"]].location_source for stop in plan["stops"]}
            plan["sources"]["location"] = next(iter(used_sources)) if len(used_sources)==1 else "mixed_catalog"
            plan["planner"]["max_stops"] = max_stops
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
            return self.nearby.find(parsed, parsed.radius_m, parsed.category)
        return await self.plan(parsed, include_options=True, token=token)
