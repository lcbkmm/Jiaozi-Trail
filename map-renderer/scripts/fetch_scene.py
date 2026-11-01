#!/usr/bin/env python3
"""Download a small, real OSM scene and optional Baidu landmarks for offline use.

Uses only Python's standard library. All output geometry is WGS84, longitude first.
Baidu supplies public POIs, not building footprints. No API key is persisted.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_BBOX = (104.070, 30.648, 104.091, 30.664)  # Approximate, WGS84.
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
BAIDU_URL = "https://api.map.baidu.com/place/v2/search"
LANDMARK_QUERIES = ("春熙路", "太古里", "大慈寺", "成都IFS")
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


class FetchError(ValueError):
    """A transport, upstream API, or source-data validation failure."""


def validate_bbox(values):
    """Validate west, south, east, north; keep downloads within a small city area."""
    if len(values) != 4:
        raise FetchError("bbox requires west south east north, in WGS84 degrees")
    try:
        west, south, east, north = map(float, values)
    except (TypeError, ValueError) as exc:
        raise FetchError("bbox values must be numbers") from exc
    if not all(math.isfinite(v) for v in (west, south, east, north)):
        raise FetchError("bbox values must be finite")
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise FetchError("bbox must satisfy -180 <= west < east <= 180 and -90 <= south < north <= 90")
    if east - west > 0.1 or north - south > 0.1:
        raise FetchError("bbox is too large for this offline demo; each span must be <= 0.1 degrees")
    return (west, south, east, north)


def bbox_around(lon, lat, size_m=1000):
    half_lat = size_m / 2 / 111320
    half_lon = size_m / 2 / (111320 * math.cos(math.radians(lat)))
    return validate_bbox((lon - half_lon, lat - half_lat, lon + half_lon, lat + half_lat))


def overpass_query(bbox):
    west, south, east, north = validate_bbox(bbox)
    bounds = f"({south:.8f},{west:.8f},{north:.8f},{east:.8f})"
    selectors = [
        'way["building"]', 'relation["building"]', 'way["highway"]',
        'way["landuse"]', 'relation["landuse"]',
        'way["leisure"~"^(park|garden|nature_reserve|recreation_ground)$"]',
        'relation["leisure"~"^(park|garden|nature_reserve|recreation_ground)$"]',
        'way["natural"~"^(water|wood|scrub|grassland)$"]',
        'relation["natural"~"^(water|wood|scrub|grassland)$"]',
        'way["waterway"~"^(river|stream|canal|drain|riverbank)$"]',
        'relation["waterway"="riverbank"]',
    ]
    return '[out:json][timeout:60];(' + ''.join(s + bounds + ';' for s in selectors) + ');out meta geom;'


def redact(message, secrets=()):
    text = str(message)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
            text = text.replace(urlencode({"ak": secret})[3:], "[REDACTED]")
    return text


def request_json(request, *, timeout=80, opener=None, service="upstream", secrets=()):
    """Do not put request URLs, which may contain credentials, in diagnostics."""
    opener = opener or urlopen
    try:
        with opener(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        raise FetchError(f"{service}: HTTP {exc.code}; request was not successful") from None
    except (URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise FetchError(f"{service}: network request failed ({type(reason).__name__})") from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise FetchError(f"{service}: response exceeded {MAX_RESPONSE_BYTES} bytes")
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise FetchError(f"{service}: response was not valid JSON") from None
    if not isinstance(payload, dict):
        raise FetchError(f"{service}: expected a JSON object")
    if service == "Overpass" and payload.get("remark"):
        raise FetchError("Overpass: " + redact(payload["remark"], secrets))
    return payload


def _coordinate(value):
    if not isinstance(value, dict):
        raise FetchError("OSM geometry contains a missing coordinate")
    try:
        lon, lat = float(value["lon"]), float(value["lat"])
    except (KeyError, TypeError, ValueError):
        raise FetchError("OSM geometry has invalid lon/lat") from None
    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
        raise FetchError("OSM geometry coordinate is outside the geographic range")
    return [lon, lat]


def _geometry_points(element):
    geometry = element.get("geometry")
    if not isinstance(geometry, list):
        raise FetchError(f"OSM {element.get('type', 'member')}/{element.get('id', element.get('ref'))} is missing geometry")
    points = []
    for raw in geometry:
        point = _coordinate(raw)
        if not points or points[-1] != point:
            points.append(point)
    if len(points) < 2:
        raise FetchError("OSM geometry must contain at least two distinct points")
    return points


def _ring(points):
    if len(points) < 4 or points[0] != points[-1] or len({tuple(p) for p in points[:-1]}) < 3:
        raise FetchError("OSM area has an incomplete ring; refusing to invent its closing edge")
    return points


def _stitch_rings(segments):
    """Join complete multipolygon way members, including reversed and unordered ones."""
    remaining = [list(segment) for segment in segments]
    rings = []
    while remaining:
        chain = remaining.pop(0)
        while chain[0] != chain[-1]:
            matched = False
            for index, segment in enumerate(remaining):
                if chain[-1] == segment[0]:
                    chain += segment[1:]
                elif chain[-1] == segment[-1]:
                    chain += list(reversed(segment))[1:]
                elif chain[0] == segment[-1]:
                    chain = segment[:-1] + chain
                elif chain[0] == segment[0]:
                    chain = list(reversed(segment))[:-1] + chain
                else:
                    continue
                remaining.pop(index)
                matched = True
                break
            if not matched:
                raise FetchError("OSM multipolygon has unconnected members; refusing to fill a missing boundary")
        rings.append(_ring(chain))
    return rings


def _signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def _oriented(ring, *, outer):
    # RFC 7946: outer CCW, holes CW. Avoid changing any original coordinates.
    return list(reversed(ring)) if (_signed_area(ring) > 0) != outer else ring


def _contains(ring, point):
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        ax, ay = a
        bx, by = b
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def _relation_geometry(relation, ways):
    outer_segments, inner_segments, member_ids = [], [], set()
    for member in relation.get("members", []):
        role = member.get("role", "")
        if member.get("type") != "way":
            if role in ("outer", "inner"):
                raise FetchError("Nested OSM multipolygon relations are not supported by this downloader")
            continue
        if role not in ("", "outer", "inner"):
            continue
        member_ids.add(member.get("ref"))
        geometry_source = member if "geometry" in member else ways.get(member.get("ref"), member)
        segment = _geometry_points(geometry_source)
        (inner_segments if role == "inner" else outer_segments).append(segment)
    outers = _stitch_rings(outer_segments)
    if not outers:
        raise FetchError(f"OSM relation/{relation.get('id')} has no outer boundary")
    polygons = [[_oriented(ring, outer=True)] for ring in outers]
    for hole in _stitch_rings(inner_segments):
        containing = [i for i, outer in enumerate(outers) if all(_contains(outer, p) for p in hole[:-1])]
        if not containing:
            raise FetchError("OSM multipolygon contains an inner boundary outside every outer boundary")
        owner = min(containing, key=lambda i: abs(_signed_area(outers[i])))
        polygons[owner].append(_oriented(hole, outer=False))
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}, member_ids
    return {"type": "MultiPolygon", "coordinates": polygons}, member_ids


def _kind(tags):
    if tags.get("building") not in (None, "no"):
        return "building"
    if tags.get("highway"):
        return "road"
    if tags.get("natural") == "water" or tags.get("water") or tags.get("waterway"):
        return "water"
    if tags.get("landuse") or tags.get("leisure") or tags.get("natural") in ("wood", "scrub", "grassland"):
        return "landuse"
    return None


def _metres(value):
    if value is None:
        return None
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|')?\s*", str(value), re.IGNORECASE)
    if not match:
        return None
    number = float(match[1])
    return number * 0.3048 if (match[2] or "").lower() in ("ft", "feet", "'") else number


def _properties(element, kind):
    tags = element.get("tags", {})
    properties = {
        "kind": kind, "name": tags.get("name:zh") or tags.get("name") or "",
        "osm_type": element["type"], "osm_id": element["id"],
        "source": "OpenStreetMap", "source_crs": "WGS84", "tags": tags,
    }
    if element.get("timestamp"):
        properties["source_updated_at"] = element["timestamp"]
    if kind == "building":
        height = _metres(tags.get("height"))
        levels = _metres(tags.get("building:levels"))
        properties.update({
            "height_m": height if height is not None else (levels * 3 if levels is not None else None),
            "min_height_m": _metres(tags.get("min_height")),
            "height_source": "osm_height" if height is not None else ("estimated_from_levels_3m" if levels is not None else "unknown"),
        })
    if kind == "road":
        properties["road_class"] = tags.get("highway", "")
    return properties


def _all_points(coordinates):
    if (isinstance(coordinates, list) and len(coordinates) >= 2
            and isinstance(coordinates[0], (int, float))):
        yield coordinates
    else:
        for item in coordinates:
            yield from _all_points(item)


def normalize_overpass(payload):
    """Convert an Overpass out-geom response, preserving holes and data provenance."""
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise FetchError("Overpass JSON must contain an elements list")
    if payload.get("remark"):
        raise FetchError("Overpass: " + str(payload["remark"]))
    elements = payload["elements"]
    if not elements:
        raise FetchError("Overpass returned no elements; an empty scene is not a successful download")
    ways = {e["id"]: e for e in elements if e.get("type") == "way" and "id" in e}
    features = []
    represented_members = set()
    # Relations first so tagged member ways are not drawn twice as filled areas.
    for element in elements:
        if element.get("type") != "relation":
            continue
        kind = _kind(element.get("tags", {}))
        if not kind or kind == "road":
            continue
        geometry, member_ids = _relation_geometry(element, ways)
        represented_members.update((kind, way_id) for way_id in member_ids)
        features.append({"type": "Feature", "id": f"relation/{element['id']}", "properties": _properties(element, kind), "geometry": geometry})
    for element in ways.values():
        kind = _kind(element.get("tags", {}))
        if not kind or (kind, element["id"]) in represented_members:
            continue
        points = _geometry_points(element)
        tags = element.get("tags", {})
        is_line = (kind == "road" and tags.get("area") != "yes") or (
            kind == "water" and tags.get("waterway") in ("river", "stream", "canal", "drain")
            and tags.get("area") != "yes" and tags.get("natural") != "water"
        )
        geometry = {"type": "LineString", "coordinates": points} if is_line else {
            "type": "Polygon", "coordinates": [_oriented(_ring(points), outer=True)]
        }
        features.append({"type": "Feature", "id": f"way/{element['id']}", "properties": _properties(element, kind), "geometry": geometry})
    if not features:
        raise FetchError("Overpass returned no usable buildings, roads, landuse, or water")
    points = [p for feature in features for p in _all_points(feature['geometry']['coordinates'])]
    bbox = [min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points)]
    return {"type": "FeatureCollection", "bbox": bbox, "features": features}


def _outside_china(lon, lat):
    return not (72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271)


def wgs84_to_gcj02(lon, lat):
    if _outside_china(lon, lat):
        return lon, lat
    x, y, pi = lon - 105, lat - 35, math.pi
    dlat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
    dlat += (20*math.sin(6*x*pi) + 20*math.sin(2*x*pi))*2/3
    dlat += (20*math.sin(y*pi) + 40*math.sin(y*pi/3))*2/3
    dlat += (160*math.sin(y*pi/12) + 320*math.sin(y*pi/30))*2/3
    dlon = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
    dlon += (20*math.sin(6*x*pi) + 20*math.sin(2*x*pi))*2/3
    dlon += (20*math.sin(x*pi) + 40*math.sin(x*pi/3))*2/3
    dlon += (150*math.sin(x*pi/12) + 300*math.sin(x*pi/30))*2/3
    radians = lat*pi/180
    magic = 1 - 0.00669342162296594323*math.sin(radians)**2
    root = math.sqrt(magic)
    dlat = dlat*180 / ((6378245*(1-0.00669342162296594323))/(magic*root)*pi)
    dlon = dlon*180 / (6378245/root*math.cos(radians)*pi)
    return lon + dlon, lat + dlat


def gcj02_to_wgs84(lon, lat):
    if _outside_china(lon, lat):
        return lon, lat
    guess_lon, guess_lat = lon, lat
    for _ in range(12):
        mapped_lon, mapped_lat = wgs84_to_gcj02(guess_lon, guess_lat)
        dx, dy = mapped_lon - lon, mapped_lat - lat
        guess_lon -= dx
        guess_lat -= dy
        if max(abs(dx), abs(dy)) < 1e-10:
            break
    return guess_lon, guess_lat


def bd09_to_gcj02(lon, lat):
    x, y = lon - 0.0065, lat - 0.006
    x_pi = math.pi * 3000 / 180
    z = math.hypot(x, y) - 0.00002 * math.sin(y*x_pi)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x*x_pi)
    return z*math.cos(theta), z*math.sin(theta)


def bd09_to_wgs84(lon, lat):
    return gcj02_to_wgs84(*bd09_to_gcj02(lon, lat))


def normalize_baidu(payload, query):
    status = payload.get("status") if isinstance(payload, dict) else None
    if str(status) != "0":
        message = payload.get("message", "missing API status") if isinstance(payload, dict) else "invalid JSON object"
        raise FetchError(f"Baidu Place API status {status}: {message}")
    results = payload.get("results")
    if not isinstance(results, list):
        raise FetchError("Baidu Place API response is missing the results list")
    features = []
    for index, result in enumerate(results):
        if not isinstance(result, dict):
            raise FetchError(f"Baidu result {index} is not an object")
        location = result.get("location")
        try:
            lon, lat = float(location["lng"]), float(location["lat"])
        except (TypeError, ValueError, KeyError):
            raise FetchError(f"Baidu result {index} has no valid location; refusing to fabricate coordinates") from None
        if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
            raise FetchError(f"Baidu result {index} has invalid geographic coordinates")
        wgs = bd09_to_wgs84(lon, lat)
        properties = {
            "kind": "poi", "source": "Baidu Place API", "source_crs": "BD09LL",
            "source_coordinates": [lon, lat], "coordinate_conversion": "BD09LL -> GCJ02 -> WGS84 (approximate)",
            "query": query, "name": str(result.get("name", "")),
            "uid": str(result.get("uid", "")), "address": str(result.get("address", "")),
            "city": str(result.get("city", "")),
            "district": str(result.get("area") or result.get("district") or ""),
        }
        feature_id = f"baidu/{properties['uid']}" if properties["uid"] else f"baidu/{query}/{index}"
        features.append({"type": "Feature", "id": feature_id, "properties": properties,
                         "geometry": {"type": "Point", "coordinates": list(wgs)}})
    total = payload.get("total")
    return features, {"query": query, "returned": len(results), "reported_total": total,
                      "page_num": 0, "page_size": 20, "all_pages_downloaded": False}


def fetch_baidu(ak, *, queries=LANDMARK_QUERIES, timeout=80, opener=None):
    if not ak:
        raise FetchError("BAIDU_MAP_AK is required for Baidu POI requests")
    features, reports, seen = [], [], set()
    for query in queries:
        params = {"query": query, "region": "成都", "city_limit": "true", "output": "json",
                  "scope": 2, "page_num": 0, "page_size": 20, "ak": ak}
        request = Request(BAIDU_URL + '?' + urlencode(params), headers={"User-Agent": "Jiaozi-Trail-Offline-Scene/1.0"})
        try:
            payload = request_json(request, timeout=timeout, opener=opener, service="Baidu Place API", secrets=(ak,))
            items, report = normalize_baidu(payload, query)
        except FetchError as exc:
            raise FetchError(redact(exc, (ak,))) from None
        reports.append(report)
        for item in items:
            if item["id"] not in seen:
                features.append(item)
                seen.add(item["id"])
    return features, reports


def choose_chunxi_center(features):
    for feature in features:
        properties = feature["properties"]
        lon, lat = feature["geometry"]["coordinates"]
        if ("春熙路" in properties["name"] and "锦江" in properties["district"]
                and (not properties["city"] or "成都" in properties["city"])
                and 103.8 < lon < 104.4 and 30.4 < lat < 30.9):
            return feature
    raise FetchError("No verified Chunxi Road POI in Chengdu Jinjiang was returned; pass an explicit WGS84 --bbox")


def load_dotenv(path):
    """Support literal KEY=VALUE only; never execute or interpolate dotenv content."""
    if not path.is_file():
        return
    for line_number, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        name, value = name.strip(), value.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise FetchError(f"Invalid dotenv assignment at line {line_number}; expected literal KEY=VALUE")
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]:
                raise FetchError(f"Unclosed dotenv quote at line {line_number}")
            value = value[1:-1]
        os.environ.setdefault(name, value)


def _inside_bbox(feature, bbox):
    lon, lat = feature["geometry"]["coordinates"]
    west, south, east, north = bbox
    return west <= lon <= east and south <= lat <= north


def _write_json(path, value):
    """Replace one output atomically; callers validate everything before writing."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
        temporary.replace(path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def build_parser():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bbox', nargs=4, type=float, metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'), help='WGS84; overrides Baidu-based 1000m scene bounds')
    parser.add_argument('--output-dir', type=Path, default=root / 'output')
    parser.add_argument('--overpass-url', default=OVERPASS_URL)
    parser.add_argument('--timeout', type=float, default=80)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--baidu-poi', action='store_true', help='Require BAIDU_MAP_AK; otherwise Baidu is automatic when a key exists')
    mode.add_argument('--no-baidu', action='store_true', help='Only download OSM, even when a Baidu key exists')
    mode.add_argument('--probe-baidu', action='store_true', help='Only validate Baidu POI API and print safe place names/coordinates')
    return parser


def run(args):
    load_dotenv(Path(__file__).resolve().parents[1] / '.env')
    ak = os.environ.get('BAIDU_MAP_AK', '').strip()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        raise FetchError('timeout must be a finite positive number')
    bbox = validate_bbox(args.bbox) if args.bbox is not None else None
    pois, baidu_reports = [], []
    if args.probe_baidu or args.baidu_poi or (ak and not args.no_baidu):
        pois, baidu_reports = fetch_baidu(ak, queries=("春熙路",) if args.probe_baidu else LANDMARK_QUERIES, timeout=args.timeout)
    if args.probe_baidu:
        # This contains only normalized public POIs, never the AK or request URL.
        print(json.dumps({"source": "Baidu Place API", "coordinate_system": "WGS84", "places": [
            {"name": p["properties"]["name"], "city": p["properties"]["city"], "district": p["properties"]["district"],
             "longitude": p["geometry"]["coordinates"][0], "latitude": p["geometry"]["coordinates"][1]} for p in pois
        ], "queries": baidu_reports}, ensure_ascii=False, indent=2))
        return 0
    center_report = {"source": "explicit WGS84 bbox" if bbox else "approximate WGS84 fallback; verify against source road names"}
    if bbox is None:
        if pois:
            center = choose_chunxi_center(pois)
            lon, lat = center['geometry']['coordinates']
            bbox = bbox_around(lon, lat)
            center_report = {"source": "Baidu Place API, BD09LL converted to WGS84", "name": center['properties']['name'],
                             "city": center['properties']['city'], "district": center['properties']['district'],
                             "longitude": lon, "latitude": lat, "approximate_scene_size_m": 1000}
        else:
            bbox = validate_bbox(DEFAULT_BBOX)
    request = Request(args.overpass_url, data=urlencode({'data': overpass_query(bbox)}).encode('utf-8'),
                      headers={'User-Agent': 'Jiaozi-Trail-Offline-Scene/1.0', 'Content-Type': 'application/x-www-form-urlencoded'})
    snapshot = request_json(request, timeout=args.timeout, service='Overpass')
    scene = normalize_overpass(snapshot)
    counts = Counter(f['properties']['kind'] for f in scene['features'])
    if not counts['building'] or not counts['road']:
        raise FetchError('OSM snapshot must contain both real buildings and roads; refusing to accept an empty/incomplete scene')
    included_pois = [p for p in pois if _inside_bbox(p, bbox)]
    scene['features'].extend(included_pois)
    scene['metadata'] = {'coordinate_system': 'WGS84', 'requested_bbox_wgs84': list(bbox), 'center': center_report}
    counts = Counter(f['properties']['kind'] for f in scene['features'])
    manifest = {
        'schema_version': 1, 'downloaded_at': datetime.now(timezone.utc).isoformat(),
        'coordinate_system': 'WGS84', 'bbox_wgs84': list(bbox), 'center': center_report,
        'feature_counts': dict(counts),
        'sources': {'osm': {'provider': 'OpenStreetMap via Overpass', 'attribution': '© OpenStreetMap contributors',
                            'license': 'ODbL', 'timestamp_osm_base': snapshot.get('osm3s', {}).get('timestamp_osm_base'),
                            'raw_snapshot': 'overpass.snapshot.json'},
                    'baidu': {'provider': 'Baidu Place API', 'enabled': bool(baidu_reports), 'queries': baidu_reports,
                              'downloaded_unique_pois': len(pois), 'pois_inside_scene': len(included_pois),
                              'source_crs': 'BD09LL', 'output_crs': 'WGS84',
                              'note': 'POIs only; not building footprints. First page per query, not exhaustive.'}},
        'rendering_notes': ['Offline snapshot, not live map data.',
                            'OSM building:levels heights use an explicit 3m-per-level estimate.',
                            'Missing building heights remain null; renderer must identify any display estimates.',
                            'Coordinates transformed from Baidu are approximate.',
                            'OSM ways may extend beyond the requested bbox; clip the rendered view to bbox_wgs84.'],
    }
    # Validate credential exclusion before creating any output files.
    for output in (snapshot, scene, manifest):
        if ak and ak in json.dumps(output, ensure_ascii=False):
            raise FetchError('Refusing to persist a source response containing the API credential')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    _write_json(args.output_dir / 'overpass.snapshot.json', snapshot)
    _write_json(args.output_dir / 'scene.geojson', scene)
    _write_json(args.output_dir / 'scene.manifest.json', manifest)
    print(json.dumps({'output_dir': str(args.output_dir.resolve()), 'bbox_wgs84': list(bbox),
                      'center': center_report, 'feature_counts': dict(counts)}, ensure_ascii=False, indent=2))
    return 0


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except (FetchError, OSError) as exc:
        # Also scrub custom source messages if an upstream error echoed the key.
        print('Scene download failed: ' + redact(exc, (os.environ.get('BAIDU_MAP_AK', ''),)), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
