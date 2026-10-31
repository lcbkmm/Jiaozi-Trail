"""Fetch a small, source-labelled candidate set. Never prints the AK."""
from __future__ import annotations
import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.config import Settings
from app.errors import AppError
from app.maps.baidu import BaiduMaps
from app.maps.nearby import distance_m
from app.schemas import Place, Point
from app.storage.database import Database


async def main():
    logging.getLogger("httpx").setLevel(logging.WARNING)
    settings = Settings.load()
    queries = json.loads((ROOT / "data/place_queries.json").read_text(encoding="utf-8"))
    runtime = ROOT / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    probe_file = runtime / "baidu_probe.json"
    if probe_file.exists():
        probe = json.loads(probe_file.read_text(encoding="utf-8"))
        p = probe["place_probes"][0]["place"]
        anchor = Point(longitude=p["longitude"], latitude=p["latitude"])
    else:
        anchor = None
    selected, rejected = [], []
    async with httpx.AsyncClient(base_url=settings.maps_base_url, follow_redirects=False,
            timeout=httpx.Timeout(15, connect=5),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2)) as client:
        provider = BaiduMaps(client, settings.baidu_ak)
        for entry in queries:
            raw = await provider.search(entry["query"])
            if not raw and entry["keywords"]:
                raw = await provider.search(entry["keywords"][0])
            candidates = []
            for row in raw:
                try:
                    place = Place(place_id=entry["id"], name=row["name"], aliases=entry.get("aliases",[]), address=row.get("address", ""),
                        uid=row["uid"], longitude=row["location"]["lng"], latitude=row["location"]["lat"],
                        category=entry["category"], retrieved_at=datetime.now(timezone.utc))
                except (ValueError, KeyError, TypeError):
                    continue
                d = distance_m(anchor, place) if anchor is not None else 0
                if d > 2000:
                    continue
                tag = (row.get("detail_info") or {}).get("tag", "")
                if entry.get("required_tags") and not all(word in tag for word in entry["required_tags"]):
                    continue
                keywords = entry["keywords"]
                if not any(word.lower() in place.name.lower() for word in keywords):
                    continue
                if any(place.uid == old.uid for old in selected):
                    continue
                keyword_bonus = sum(word.lower() in place.name.lower() for word in keywords)
                start_bonus = 1 if entry["category"] == "start" and "地铁站" in place.name else 0
                exact_bonus = int(place.name == entry.get("preferred_name", entry["query"]))
                candidates.append(((-exact_bonus, -keyword_bonus-start_bonus, d), place))
            if not candidates:
                rejected.append({"place_id": entry["id"], "reason": "no_unique_matching_POI_within_2km"})
                continue
            place = min(candidates, key=lambda item: item[0])[1]
            selected.append(place)
            print(json.dumps({"place_id": place.place_id, "name": place.name,
                              "entrance_reviewed": False}, ensure_ascii=False), flush=True)
    if len(selected) < 5 or not any(p.place_id == "chunxi_start" for p in selected):
        print(json.dumps({"error": "Insufficient usable points", "selected": len(selected), "rejected": rejected}))
        return 1
    temporary = runtime / "places.json.tmp"
    temporary.write_text(json.dumps([p.model_dump(mode="json") for p in selected], ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    temporary.replace(settings.places_path)
    database = Database(settings.database_path)
    database.seed_places(selected)
    print(json.dumps({"saved_places": len(selected), "source": "baidu_place_v3", "rejected": rejected}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except AppError as error:
        print(json.dumps({"code": error.code, "message": error.message, "details": error.details}, ensure_ascii=False))
        sys.exit(1)
