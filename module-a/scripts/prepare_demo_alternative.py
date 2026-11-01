"""Append one verified nearby hotpot POI; leave all existing places unchanged."""
import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from app.config import Settings
from app.maps.baidu import BaiduMaps
from app.maps.nearby import distance_m
from app.schemas import Place, CampaignStop
from app.storage.database import Database

async def main():
    logging.getLogger('httpx').setLevel(logging.WARNING)
    settings=Settings.load()
    places=[Place.model_validate(p) for p in json.loads(settings.places_path.read_text(encoding='utf-8'))]
    anchor=next(p for p in places if p.place_id=='chunxi_start')
    place=next((p for p in places if p.place_id=='hotpot_alt'),None)
    if place is None:
        async with httpx.AsyncClient(base_url=settings.maps_base_url,timeout=15,follow_redirects=False) as client:
            provider=BaiduMaps(client,settings.baidu_ak)
            rows=await provider.search('海底捞 春熙路')
        candidates=[]
        for row in rows:
            try:
                item=Place(place_id='hotpot_alt',name=row['name'],address=row.get('address',''),uid=row['uid'],
                    longitude=row['location']['lng'],latitude=row['location']['lat'],category='meal',
                    retrieved_at=datetime.now(timezone.utc))
            except (KeyError,TypeError,ValueError): continue
            if '海底捞' not in item.name or item.uid in {p.uid for p in places}: continue
            if distance_m(anchor,item)>1800: continue
            candidates.append(item)
        if not candidates: raise RuntimeError('No verified nearby alternative; existing data retained')
        place=min(candidates,key=lambda p:distance_m(anchor,p))
        places.append(place)
        settings.places_path.write_text(json.dumps([p.model_dump(mode='json') for p in places],ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    campaign=json.loads(settings.campaign_path.read_text(encoding='utf-8'))
    if not any(s['place_id']=='hotpot_alt' for s in campaign['stops']):
        stop=CampaignStop(stop_id='stop_hotpot_alt',place_id='hotpot_alt',title='替代火锅正餐（演示预算）',
            category='meal',interests=['food','hotpot'],dwell_s=3600,cost_min_fen=10000,cost_max_fen=15000,
            windows=[{'opens':'10:00','closes':'21:00'}],queue_s=300,status='open',source='demo',benefits=[])
        campaign['stops'].append(stop.model_dump(mode='json'))
        settings.campaign_path.write_text(json.dumps(campaign,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    Database(settings.database_path).seed_places(places)
    print(json.dumps({'place':place.model_dump(mode='json'),'distance_from_start_m':round(distance_m(anchor,place)),
                      'notice':'真实百度POI；排队、预算、营业、停留为演示配置，入口未人工核验'},ensure_ascii=False))

if __name__=='__main__': asyncio.run(main())
