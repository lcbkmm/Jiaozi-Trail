"""Build a source-labelled offline mini-program preview from prepared real routes."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from fastapi.testclient import TestClient
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.config import Settings
from app.main import create_app


def main():
    settings = Settings.load()
    # Preview build must not fan out additional live API requests.
    from dataclasses import replace
    settings = replace(settings, maps_mode="prepared")
    with TestClient(create_app(settings)) as client:
        token = client.post("/api/v1/demo/sessions", json={}).json()["data"]["session_token"]
        client.headers["X-Demo-Session"] = token
        places = client.get("/api/v1/places").json()["data"]
        preferences = {"start_place_id":"chunxi_start", "departure_at":"2026-10-31T14:00:00+08:00",
                      "max_duration_s":10800, "budget_per_person_fen":20000,
                      "max_walk_m":3000, "interests":["coffee","food","landmark"]}
        response = client.post("/api/v1/route-options", json=preferences)
        if response.status_code != 200:
            print(json.dumps(response.json(), ensure_ascii=False)); return 1
        options = response.json()["data"]["options"]
        details = {place["place_id"]: client.get("/api/v1/places/"+place["place_id"]).json()["data"] for place in places}
        snapshot = {"generated_at":datetime.now(timezone.utc).isoformat(),
                    "mode":"prepared_preview", "places":places, "details":details, "options":options,
                    "notice":"真实百度位置与已准备路段；活动/排队/价格为演示；仅默认条件可离线预览。"}
        output = ROOT / "miniprogram/data/preview.js"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("module.exports = "+json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))+";\n", encoding="utf-8")
        print(json.dumps({"preview_options":len(options), "places":len(places),
                          "route_styles":[o["option_id"] for o in options],
                          "new_map_calls":client.app.state.maps.calls}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
