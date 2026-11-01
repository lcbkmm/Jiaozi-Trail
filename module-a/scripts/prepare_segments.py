"""Prepare directed walking segments once, reusing the local cache."""
import asyncio
import json
import logging
import sys
from pathlib import Path
import httpx
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.config import Settings
from app.maps.baidu import BaiduMaps
from app.maps.segments import SegmentRepository
from app.schemas import Place
from app.storage.database import Database


async def main():
    logging.getLogger("httpx").setLevel(logging.WARNING)
    settings = Settings.load()
    places = [Place.model_validate(p) for p in json.loads(settings.places_path.read_text(encoding="utf-8"))]
    database = Database(settings.database_path)
    database.seed_places(places)
    async with httpx.AsyncClient(base_url=settings.maps_base_url, follow_redirects=False,
            timeout=httpx.Timeout(15, connect=5, pool=20),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2)) as client:
        maps = BaiduMaps(client, settings.baidu_ak)
        segments = SegmentRepository(database, maps, settings.maps_mode)
        graph, failures = await segments.graph(places, max_live_queries=None, timeout_s=None)
        report = {"places": len(places), "expected_segments": len(places)*(len(places)-1),
                  "usable_segments": len(graph), "new_upstream_calls": maps.calls,
                  "failures": failures, "source": "baidu_walking"}
        (ROOT / "runtime/segment_preparation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
