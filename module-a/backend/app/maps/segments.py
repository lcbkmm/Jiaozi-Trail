from __future__ import annotations
import asyncio
import hashlib
import json
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from app.errors import AppError
from app.schemas import Point, WalkingLeg


class SegmentRepository:
    def __init__(self, database, provider, mode):
        self.database, self.provider, self.mode = database, provider, mode
        self.locks = {}
        self.position_cache = OrderedDict()

    @staticmethod
    def cache_key(origin, target):
        descriptor = {"provider": "baidu_walking_v1", "mode": "walking", "coord_system": "gcj02",
                      "points": [[p.place_id, p.longitude, p.latitude, p.entrance_version]
                                 for p in (origin, target)]}
        return hashlib.sha256(json.dumps(descriptor, sort_keys=True).encode()).hexdigest()

    @asynccontextmanager
    async def lock(self,key):
        entry=self.locks.setdefault(key,[asyncio.Lock(),0])
        entry[1]+=1
        try:
            async with entry[0]:yield
        finally:
            entry[1]-=1
            if entry[1]==0:self.locks.pop(key,None)

    async def get_from_position(self,origin,target):
        key=self.cache_key(origin,target)
        async with self.lock(('position',key)):
            cached=self.position_cache.get(key)
            if cached and cached[0]>time.monotonic():
                self.position_cache.move_to_end(key)
                return cached[1].model_copy(update={'delivery':'cached'})
            leg=await self.provider.walking(origin,target)
            self.position_cache[key]=(time.monotonic()+90,leg)
            self.position_cache.move_to_end(key)
            while len(self.position_cache)>128:self.position_cache.popitem(last=False)
            return leg

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
        async with self.lock(key):
            cached = self.database.segment(key)
            if cached:
                return WalkingLeg.model_validate({**cached, "delivery": "cached"})
            leg = await self.provider.walking(origin, target)
            self.database.save_segment(key, leg)
            return leg

    async def graph(self, places, *, max_live_queries=12, timeout_s=12, edges=None):
        by_id={place.place_id:place for place in places}
        if edges is None:
            pairs=[(a,b) for a in places for b in places if a.place_id!=b.place_id]
        else:
            pairs=[(by_id[a],by_id[b]) for a,b in dict.fromkeys(edges) if a!=b]
        keys={self.cache_key(a,b):(a,b) for a,b in pairs}
        cached=self.database.segments(keys)
        graph={(a.place_id,b.place_id):WalkingLeg.model_validate({**cached[key],'delivery':'cached'})
               for key,(a,b) in keys.items() if key in cached}
        missing=[(a,b) for key,(a,b) in keys.items() if key not in cached]
        failures=[]
        if self.mode!='baidu':
            failures=[{'from_place_id':a.place_id,'to_place_id':b.place_id,'code':'MAP_UNAVAILABLE','details':{}}
                      for a,b in missing]
            return graph,failures
        active=missing if max_live_queries is None else missing[:max_live_queries]
        failures.extend({'from_place_id':a.place_id,'to_place_id':b.place_id,'code':'ROUTE_QUERY_BUDGET','details':{}}
                        for a,b in missing[len(active):])
        async def one(a,b):
            try:return (a.place_id,b.place_id),await self.get(a,b),None
            except AppError as error:return (a.place_id,b.place_id),None,{'code':error.code,'details':error.details}
        tasks=[asyncio.create_task(one(a,b)) for a,b in active]
        if not tasks:return graph,failures
        try:done,pending=await asyncio.wait(tasks,timeout=timeout_s)
        except asyncio.CancelledError:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            raise
        for task in pending:task.cancel()
        await asyncio.gather(*pending,return_exceptions=True)
        for task in done:
            pair,leg,error=task.result()
            if leg is not None:graph[pair]=leg
            else:failures.append({'from_place_id':pair[0],'to_place_id':pair[1],**error})
        failures.extend({'from_place_id':a.place_id,'to_place_id':b.place_id,'code':'UPSTREAM_TIMEOUT','details':{}}
                        for (a,b),task in zip(active,tasks) if task in pending)
        return graph,failures
