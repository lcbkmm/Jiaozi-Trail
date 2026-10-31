"""Probe Baidu Places and walking APIs without printing credentials.

Loads module-a/.env.local. Writes a sanitized report under ignored runtime/.
This script validates upstream access; it does not implement the route service.
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

MODULE_ROOT = Path(__file__).resolve().parents[1]
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip().strip("\"'")
    return values


def safe_message(value, key: str) -> str:
    text = str(value).replace(key, "[REDACTED]")
    text = re.sub(r"(?i)([?&]ak=)[^&\s]+", r"\1[REDACTED]", text)
    return text[:300]


def call_api(path: str, params: dict, key: str) -> dict:
    query = dict(params, ak=key)
    request = Request(
        "https://api.map.baidu.com" + path + "?" + urlencode(query),
        headers={"Accept": "application/json", "User-Agent": "Jiaozi-Trail-MapProbe/1.0"},
    )
    try:
        with build_opener(NoRedirect()).open(request, timeout=15) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            return {"ok": False, "error_type": "response_too_large"}
        body = json.loads(raw.decode("utf-8"))
        if not isinstance(body, dict):
            return {"ok": False, "error_type": "invalid_response_shape"}
        status = body.get("status")
        if status != 0:
            return {
                "ok": False,
                "error_type": "baidu_api_error",
                "api_status": status,
                "message": safe_message(body.get("message", body.get("msg", "")), key),
            }
        return {"ok": True, "body": body}
    except HTTPError as error:
        return {"ok": False, "error_type": "http_error", "http_status": error.code}
    except (TimeoutError, URLError):
        return {"ok": False, "error_type": "network_or_timeout"}
    except (UnicodeError, ValueError):
        return {"ok": False, "error_type": "invalid_json"}
    except Exception as error:
        return {"ok": False, "error_type": type(error).__name__}


def find_place(query: str, key: str) -> dict:
    result = call_api(
        "/place/v3/region",
        {"query": query, "region": "成都市", "output": "json", "scope": 2,
         "page_size": 5, "ret_coordtype": "gcj02ll"},
        key,
    )
    if not result["ok"]:
        return dict(result, query=query)
    candidates = result["body"].get("results", [])
    usable = []
    for row in candidates:
        location = row.get("location") or {}
        lng, lat = location.get("lng"), location.get("lat")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                   and math.isfinite(v) for v in (lng, lat)):
            continue
        usable.append({
            "uid": row.get("uid"), "name": row.get("name"),
            "address": row.get("address"), "longitude": lng, "latitude": lat,
            "coord_system": "gcj02", "source": "baidu_place_v3",
        })
    if not usable:
        return {"ok": False, "query": query, "error_type": "no_valid_place"}
    compact_query = query.replace(" ", "").lower()
    selected = next((row for row in usable
                     if str(row["name"]).replace(" ", "").lower() == compact_query), usable[0])
    return {"ok": True, "query": query, "candidate_count": len(usable),
            "selection": "automatic_probe_only_needs_entrance_review", "place": selected}


def probe_walking(origin: dict, destination: dict, key: str) -> dict:
    result = call_api(
        "/directionlite/v1/walking",
        {"origin": str(origin["latitude"]) + "," + str(origin["longitude"]),
         "destination": str(destination["latitude"]) + "," + str(destination["longitude"]),
         "coord_type": "gcj02", "ret_coordtype": "gcj02", "steps_info": 1},
        key,
    )
    if not result["ok"]:
        return result
    routes = (result["body"].get("result") or {}).get("routes") or []
    if not routes:
        return {"ok": False, "error_type": "no_walking_route"}
    route = routes[0]
    distance, duration = route.get("distance"), route.get("duration")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
               and math.isfinite(v) and v >= 0 for v in (distance, duration)):
        return {"ok": False, "error_type": "invalid_route_metrics"}
    steps = route.get("steps") or []
    path_point_count = sum(len(step.get("path", "").split(";"))
                           for step in steps if step.get("path"))
    return {"ok": path_point_count > 0,
            "error_type": None if path_point_count else "missing_path_geometry",
            "origin_name": origin.get("name"), "destination_name": destination.get("name"),
            "distance_m": distance, "duration_s": duration,
            "step_count": len(steps), "path_point_count": path_point_count,
            "coord_system": "gcj02", "entrances_manually_reviewed": False}


def main() -> int:
    try:
        settings = load_env(MODULE_ROOT / ".env.local")
    except OSError:
        print(json.dumps({"ok": False, "error_type": "local_config_missing"}))
        return 2
    key = settings.get("BAIDU_SERVER_AK", "")
    if not key:
        print(json.dumps({"ok": False, "error_type": "baidu_ak_missing"}))
        return 2
    places = []
    for query in ("成都IFS", "成都太古里"):
        result = find_place(query, key)
        places.append(result)
        if result.get("error_type") == "baidu_api_error":
            break  # Do not repeat rejected authentication or permission requests.
    if len(places) == 2 and all(row["ok"] for row in places):
        walking = probe_walking(places[0]["place"], places[1]["place"], key)
    else:
        walking = {"ok": False, "skipped": True, "reason": "place_probe_not_ready"}
    report = {
        "observed_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
        "provider": "baidu", "credential_source": "local_environment_file",
        "place_probes": places, "walking_probe": walking,
        "all_passed": len(places) == 2 and all(row["ok"] for row in places) and walking["ok"],
    }
    report_dir = MODULE_ROOT / "runtime"
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "baidu_probe.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
