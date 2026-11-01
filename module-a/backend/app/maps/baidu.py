from __future__ import annotations
import asyncio
import math
from datetime import datetime, timezone
import httpx
from app.errors import AppError
from app.schemas import Place, Point, WalkingLeg


class BaiduMaps:
    def __init__(self, client: httpx.AsyncClient, ak: str):
        self.client, self.ak = client, ak
        self.limit = asyncio.Semaphore(1)
        self.last_request_at = 0.0
        self.calls = 0

    async def request(self, path, params):
        if not self.ak:
            raise AppError("MAP_UNAVAILABLE", "本地配置中缺少百度 AK。", 503)
        for attempt in range(3):
            try:
                async with self.limit:
                    delay = 1.05 - (asyncio.get_running_loop().time() - self.last_request_at)
                    if delay > 0:
                        await asyncio.sleep(delay)
                    self.last_request_at = asyncio.get_running_loop().time()
                    self.calls += 1
                    response = await self.client.get(path, params={**params, "ak": self.ak})
                if response.status_code != 200:
                    raise AppError("MAP_UNAVAILABLE", "百度地图 HTTP 请求失败。", 503,
                                   {"http_status": response.status_code})
                body = response.json()
            except httpx.TimeoutException:
                raise AppError("UPSTREAM_TIMEOUT", "百度地图请求超时。", 504) from None
            except (httpx.HTTPError, ValueError):
                raise AppError("MAP_UNAVAILABLE", "百度地图连接或响应异常。", 503) from None
            status = body.get("status") if isinstance(body, dict) else None
            if status == 0:
                return body
            if status in (401, 402) and attempt < 2:
                await asyncio.sleep(1.2 * (attempt+1))
                continue
            raise AppError("MAP_UNAVAILABLE", "百度地图未接受本次调用，请检查权限、来源或配额。", 503,
                           {"provider_status": status})
        raise AppError("MAP_UNAVAILABLE", "百度地图限流，请稍后重试。", 503)

    async def search(self, query: str):
        body = await self.request("/place/v3/region", {
            "query": query, "region": "成都市", "output": "json", "scope": 2,
            "page_size": 10, "ret_coordtype": "gcj02ll"})
        return body.get("results") or []

    async def walking(self, origin: Place, target: Place):
        body = await self.request("/directionlite/v1/walking", {
            "origin": f"{origin.latitude},{origin.longitude}",
            "destination": f"{target.latitude},{target.longitude}",
            "coord_type": "gcj02", "ret_coordtype": "gcj02", "steps_info": 1})
        routes = (body.get("result") or {}).get("routes") or []
        if not routes:
            raise AppError("WALKING_UNREACHABLE", "两个地点之间没有可用步行路线。", 422)
        raw = routes[0]
        points = []
        try:
            for step in raw.get("steps") or []:
                for pair in (step.get("path") or "").split(";"):
                    if not pair:
                        continue
                    lng, lat = map(float, pair.split(","))
                    point = Point(longitude=lng, latitude=lat)
                    if not points or point != points[-1]:
                        points.append(point)
            if not points:
                raise ValueError("Missing route geometry")
            for value in (raw["distance"], raw["duration"]):
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise ValueError("Invalid metrics")
            return WalkingLeg(from_place_id=origin.place_id, to_place_id=target.place_id,
                distance_m=math.ceil(raw["distance"]), duration_s=math.ceil(raw["duration"]),
                points=points, retrieved_at=datetime.now(timezone.utc),
                entrance_version=f"{origin.entrance_version}:{target.entrance_version}")
        except (ValueError, KeyError, TypeError):
            raise AppError("MAP_UNAVAILABLE", "百度步行路径格式不完整。", 503) from None
