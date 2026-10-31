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

    def find(self, point, radius_m, category=None):
        # Redis can implement this interface later. Record the actual source on fallback.
        source = "sqlite" if self.provider == "sqlite" else "sqlite_fallback"
        rows = []
        for place in self.database.places():
            d = distance_m(point, place)
            if d <= radius_m and (category is None or place.category == category):
                rows.append({**place.model_dump(mode="json"), "approx_distance_m": round(d),
                             "nearby_source": source})
        return sorted(rows, key=lambda row: row["approx_distance_m"])
