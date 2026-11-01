"""Read-only catalog snapshot. Rebuilt on explicit catalog import, not per request."""
import heapq
import math
import re
import hashlib
import json
from collections import defaultdict
from app.maps.nearby import distance_m
from app.planner.search import INTEREST_LABELS


class CatalogIndex:
    CELL=.005  # Roughly 500m in this demo area. Distances are checked exactly afterwards.

    def __init__(self,places,stops):
        self.places={p.place_id:p for p in places}
        self.stops={s.place_id:s for s in stops if s.place_id in self.places}
        if len(self.places)!=len(places):raise ValueError("Duplicate place IDs in catalog")
        if len(self.stops)!=len(stops):
            raise ValueError("Duplicate or missing place IDs in campaign stops")
        self.by_tag=defaultdict(set)
        self.cells=defaultdict(set)
        self.names=defaultdict(set)
        self.exact_names=defaultdict(set)
        self.labels=dict(INTEREST_LABELS)
        for stop in stops:
            self.labels.update(stop.experience_labels)
            for tag in stop.interests: self.by_tag[tag].add(stop.place_id)
        for place in places:
            self.cells[self.cell(place)].add(place.place_id)
            for name in [place.place_id,place.name,*place.aliases]:
                text=self.normalize(name)
                self.exact_names[text].add(place.place_id)
                for i in range(len(text)-1):self.names[text[i:i+2]].add(place.place_id)
        self.vocabulary={tag:self.labels.get(tag,tag) for tag in sorted(set(self.by_tag)|set(INTEREST_LABELS))}
        payload={'places':[p.model_dump(mode='json') for p in sorted(places,key=lambda p:p.place_id)],
                 'stops':[s.model_dump(mode='json') for s in sorted(stops,key=lambda s:s.place_id)]}
        self.version=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()[:20]

    @staticmethod
    def normalize(text):return re.sub(r"[\s·（）()\-]","",text).lower()

    def resolve(self,query):
        normalized=self.normalize(query)
        exact=self.exact_names.get(normalized)
        if exact:return [self.places[pid] for pid in sorted(exact)]
        grams={normalized[i:i+2] for i in range(len(normalized)-1)}
        if not grams:return []
        sets=[self.names.get(gram,set()) for gram in grams]
        ids=set.intersection(*sets) if sets else set()
        return [self.places[pid] for pid in sorted(ids) if any(normalized in self.normalize(name) for name in [self.places[pid].name,*self.places[pid].aliases])]

    @classmethod
    def cell(cls,point):return (math.floor(point.longitude/cls.CELL),math.floor(point.latitude/cls.CELL))

    def nearby_ids(self,point,radius_m):
        latitude_delta=radius_m/110000
        longitude_delta=latitude_delta/max(.01,math.cos(math.radians(point.latitude)))
        x1,x2=math.floor((point.longitude-longitude_delta)/self.CELL),math.floor((point.longitude+longitude_delta)/self.CELL)
        y1,y2=math.floor((point.latitude-latitude_delta)/self.CELL),math.floor((point.latitude+latitude_delta)/self.CELL)
        # Cap grid work at the number of catalog cells for large radius searches.
        if (x2-x1+1)*(y2-y1+1)>len(self.cells):
            cells=(ids for (x,y),ids in self.cells.items() if x1<=x<=x2 and y1<=y<=y2)
        else:
            cells=(self.cells.get((x,y),()) for x in range(x1,x2+1) for y in range(y1,y2+1))
        return {pid for ids in cells for pid in ids if distance_m(point,self.places[pid])<=radius_m}

    def model_candidates(self,text,anchor,explicit_ids=(),limit=24):
        scores=defaultdict(int)
        text=text.lower()
        for gram in {text[i:i+2] for i in range(len(text)-1)}:
            for pid in self.names.get(gram,()):scores[pid]+=1
        matched=heapq.nsmallest(limit,scores,key=lambda pid:(-scores[pid],distance_m(anchor,self.places[pid]),pid))
        chosen=list(dict.fromkeys([pid for pid in explicit_ids if pid in self.places]+matched))[:limit]
        if len(chosen)<limit:
            nearby=self.nearby_ids(anchor,3000)
            chosen.extend(pid for pid in heapq.nsmallest(limit,nearby,key=lambda pid:(distance_m(anchor,self.places[pid]),pid)) if pid not in chosen)
        return [{"place_id":pid,"name":self.places[pid].name,"aliases":self.places[pid].aliases,"category":self.places[pid].category,
                 "interests":self.stops[pid].interests if pid in self.stops else []} for pid in chosen[:limit]]
