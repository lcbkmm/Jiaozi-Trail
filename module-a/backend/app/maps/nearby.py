import math


def distance_m(a, b):
    lat1, lat2 = math.radians(a.latitude), math.radians(b.latitude)
    dlat = lat2 - lat1
    dlng = math.radians(b.longitude - a.longitude)
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1.0, math.sqrt(max(0.0, hav))))


class NearbyPlaceRepository:
    def __init__(self, database, provider="sqlite"):
        self.database, self.provider = database, provider

    def find(self, point, radius_m, category=None, *, interest=None, limit=20, catalog=None):
        from app.catalog import CatalogIndex
        import heapq
        from app.errors import AppError
        if catalog is None:
            key=self.database.catalog_revision
            if getattr(self,'_revision',None)!=key:
                self._index=CatalogIndex(self.database.places(),[])
                self._revision=key
            catalog=self._index
        if interest is not None and interest not in catalog.vocabulary:
            raise AppError('UNSUPPORTED_EXPERIENCE','目录尚无此体验标签。',422)
        source='sqlite' if self.provider=='sqlite' else 'sqlite_fallback'
        ids=catalog.nearby_ids(point,radius_m)
        if interest:ids &= catalog.by_tag.get(interest,set())
        candidates=(catalog.places[pid] for pid in ids if category is None or catalog.places[pid].category==category)
        places=heapq.nsmallest(min(limit,100),candidates,key=lambda p:(distance_m(point,p),p.place_id))
        return [{**place.model_dump(mode='json'),'approx_distance_m':round(distance_m(point,place)),
                 'nearby_source':source} for place in places]
