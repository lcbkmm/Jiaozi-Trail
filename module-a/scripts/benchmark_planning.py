"""Synthetic scale benchmark; never measures map/model latency or writes demo data."""
import asyncio
import json
import statistics
import sys
import tempfile
import time
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from app.storage.database import Database
from app.schemas import Place,CampaignStop,Preferences,WalkingLeg,Point
from app.tools import BusinessTools
from app.maps.nearby import NearbyPlaceRepository,distance_m

class FixtureSegments:
    mode='prepared'
    def __init__(self):self.calls=[]
    async def graph(self,points,edges=None):
        by_id={p.place_id:p for p in points}
        edges=edges if edges is not None else [(a.place_id,b.place_id) for a in points for b in points if a!=b]
        self.calls.append(len(edges))
        result={}
        for a,b in edges:
            if a==b:continue
            x,y=by_id[a],by_id[b]
            meters=round(distance_m(x,y)*1.2)
            result[a,b]=WalkingLeg(from_place_id=a,to_place_id=b,distance_m=meters,duration_s=round(meters/.9),
                points=[Point(longitude=x.longitude,latitude=x.latitude),Point(longitude=y.longitude,latitude=y.latitude)],
                retrieved_at=datetime(2026,10,31,tzinfo=timezone.utc),entrance_version='fixture')
        return result,[]

def percentile(values,p):return sorted(values)[max(0,int(len(values)*p+.999)-1)]

async def measure(count,path):
    now=datetime(2026,10,31,tzinfo=timezone.utc)
    anchor=Place(place_id='start',uid='start',name='起点',address='synthetic',category='start',longitude=104.08,latitude=30.65,retrieved_at=now)
    places=[anchor];stops=[]
    for i in range(count):
        pid='shop_'+str(i)
        tag=['coffee','food','culture','hotpot'][i%4]
        category={'coffee':'coffee','food':'meal','culture':'culture','hotpot':'meal'}[tag]
        places.append(Place(place_id=pid,uid=pid,name='测试'+tag+'商家'+str(i),address='synthetic',category=category,
            longitude=104.08+(i%100-50)*.0003,latitude=30.65+(i//100%100-50)*.0003,retrieved_at=now))
        stops.append(CampaignStop(stop_id='s_'+pid,place_id=pid,title='synthetic',category=category,interests=[tag],
            dwell_s=600,cost_min_fen=0,cost_max_fen=1000,windows=[{'opens':'09:00','closes':'22:00'}]))
    database=Database(path)
    database.seed_places(places)
    segments=FixtureSegments()
    tools=BusinessTools(database,stops,segments,NearbyPlaceRepository(database),ROOT/'data/campaign.json')
    start=time.perf_counter();index=tools.catalog();index_ms=(time.perf_counter()-start)*1000
    pref=Preferences(start_place_id='start',departure_at='2026-11-01T14:00:00+08:00',max_duration_s=10800,budget_per_person_fen=20000,interests=['coffee','culture'],required_experiences=['hotpot'])
    latencies=[];model_recall=[];last=None
    for i in range(16):
        start=time.perf_counter();last=await tools.plan(pref,include_options=True);elapsed=(time.perf_counter()-start)*1000
        start=time.perf_counter();context=index.model_candidates('想吃火锅并看看文化景点',anchor,['start']);model_elapsed=(time.perf_counter()-start)*1000
        if i:latencies.append(elapsed);model_recall.append(model_elapsed)
    return {'merchants':count,'cold_index_build_ms':round(index_ms,2),'warm_planning_p50_ms':round(statistics.median(latencies),2),
        'warm_planning_p95_ms':round(percentile(latencies,.95),2),'model_candidate_recall_p95_ms':round(percentile(model_recall,.95),2),
        'graph_edges':max(segments.calls),'model_catalog_count':len(context),'planning_candidates':last['options'][0]['planner']['candidate_count']}

async def main():
    results=[]
    with tempfile.TemporaryDirectory(prefix='jiaozi-scale-') as tmp:
        for count in (100,1000,10000):
            row=await measure(count,Path(tmp)/('scale_'+str(count)+'.sqlite3'))
            results.append(row);print(json.dumps(row),flush=True)
    report={'mode':'synthetic local recall and planning only; no actual model/map calls; not phone or end-to-end latency',
            'repeats':15,'results':results}
    (ROOT/'runtime/planning_scale_benchmark.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

if __name__=='__main__':asyncio.run(main())
