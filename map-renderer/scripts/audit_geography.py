"""Audit saved geometry against the original OSM response and optional Baidu conversion.

No coordinates are shifted to make unrelated POIs look aligned. Does not modify scene data.
"""
import argparse
import json
import math
from pathlib import Path
import os
from urllib.parse import urlencode
from urllib.request import Request
from fetch_scene import load_dotenv, normalize_overpass, request_json, FetchError


ROOT = Path(__file__).resolve().parents[1]


def distance(a, b):
    lat = (a[1] + b[1]) / 2
    return math.hypot((a[0] - b[0]) * 111319.49 * math.cos(math.radians(lat)), (a[1] - b[1]) * 111319.49)


def audit(online=False):
    output = ROOT / 'output'
    scene = json.loads((output / 'scene.geojson').read_text(encoding='utf-8'))
    snapshot = json.loads((output / 'overpass.snapshot.json').read_text(encoding='utf-8'))
    normalized = normalize_overpass(snapshot)
    raw = {(f['properties'].get('osm_type'), f['properties'].get('osm_id')): f for f in normalized['features']}
    mismatches, count = [], 0
    for feature in scene['features']:
        p = feature['properties']
        if p.get('source') != 'OpenStreetMap':
            continue
        count += 1
        original = raw.get((p.get('osm_type'), p.get('osm_id')))
        if not original or original['geometry'] != feature['geometry']:
            mismatches.append({'name': p.get('name'), 'osm_id': p.get('osm_id')})
    report = {'coordinateSystem': 'WGS84', 'osmFeatureCount': count, 'geometryMismatches': mismatches,
              'bbox': scene['metadata']['requested_bbox_wgs84'], 'officialConversion': None,
              'limits': ['OSM is a source snapshot, not a ground survey.',
                         'POI locations can be entrances or businesses, not building centers.',
                         'Baidu inverse transforms are approximate; source BD09 is preserved.']}
    if online:
        load_dotenv(ROOT / '.env')
        key = os.environ.get('BAIDU_MAP_AK', '').strip()
        if not key:
            raise FetchError('BAIDU_MAP_AK is required for official conversion comparison')
        selected = [f for f in scene['features'] if f['properties'].get('name') in
                    ('成都IFS国际金融中心', '成都太古里-西出入口', '春熙路步行街') and f['properties'].get('source_crs') == 'BD09LL']
        coords = ';'.join(','.join(map(str, f['geometry']['coordinates'])) for f in selected)
        url = 'https://api.map.baidu.com/geoconv/v1/?' + urlencode({'ak': key, 'coords': coords, 'from': 1, 'to': 5, 'output': 'json'})
        payload = request_json(Request(url), timeout=25, service='Baidu coordinate conversion', secrets=(key,))
        if payload.get('status') != 0:
            report['officialConversion'] = {'available': False, 'status': payload.get('status'),
                                              'note': 'The existing server application did not authorize this conversion request.'}
        elif len(payload.get('result', [])) == len(selected):
            report['officialConversion'] = {'available': True, 'checks': [
                {'name': f['properties']['name'], 'sourceBD09': f['properties']['source_coordinates'],
                 'officialForwardBD09': [p['x'], p['y']],
                 'roundTripErrorMetersApprox': round(distance([p['x'], p['y']], f['properties']['source_coordinates']), 3)}
                for f, p in zip(selected, payload['result'])]}
    path = output / 'geography.audit.json'
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baidu-verify', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.baidu_verify), ensure_ascii=True, indent=2))
    except (FetchError, OSError, ValueError, KeyError) as exc:
        parser.exit(1, f'Geography audit failed: {exc}\n')
