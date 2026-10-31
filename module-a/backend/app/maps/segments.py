from __future__ import annotations
import asyncio
import hashlib
import json
from datetime import datetime, timezone
from app.errors import AppError
from app.schemas import Point, WalkingLeg


class SegmentRepository:
    def __init__(self, database, provider, mode):
        self.database, self.provider, self.mode = database, provider, mode
        self.locks = {}

    @staticmethod
    def cache_key(origin, target):
        descriptor = {"provider": "baidu_walking_v1", "mode": "walking", "coord_system": "gcj02",
                      "points": [[p.place_id, p.longitude, p.latitude, p.entrance_version]
                                 for p in (origin, target)]}
        return hashlib.sha256(json.dumps(descriptor, sort_keys=True).encode()).hexdigest()

    async def get(self, origin, target):
        if origin.place_id == target.place_id:
            return WalkingLeg(from_place_id=origin.place_id, to_place_id=target.place_id,
                distance_m=0, duration_s=0, points=[Point(longitude=origin.longitude, latitude=origin.latitude)],
                source="same_location", retrieved_at=datetime.now(timezone.utc),
                entrance_version=f"{origin.entrance_version}:{target.entrance_version}")
        key = self.cache_key(origin, target)
        cached = self.database.segment(key)
        if cached:
            return WalkingLeg.model_validate({**cached, "delivery": "cached"})
        if self.mode != "baidu":
            raise AppError("MAP_UNAVAILABLE", "所需步行路段尚未准备，且未启用实时地图。", 503)
        lock = self.locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self.database.segment(key)
            if cached:
                return WalkingLeg.model_validate({**cached, "delivery": "cached"})
            leg = await self.provider.walking(origin, target)
            self.database.save_segment(key, leg)
            return leg

    async def graph(self, places):
        pairs = [(a, b) for a in places for b in places if a.place_id != b.place_id]
        async def one(a, b):
            try:
                return (a.place_id, b.place_id), await self.get(a, b), None
            except AppError as error:
                return (a.place_id, b.place_id), None, {"code": error.code, "details": error.details}
        results = await asyncio.gather(*(one(a, b) for a, b in pairs))
        graph = {pair: leg for pair, leg, error in results if leg is not None}
        failures = [{"from_place_id": pair[0], "to_place_id": pair[1], **error}
                    for pair, leg, error in results if error is not None]
        return graph, failures
