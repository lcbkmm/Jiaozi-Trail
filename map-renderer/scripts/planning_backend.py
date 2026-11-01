#!/usr/bin/env python3
"""Local, private bridge to the complete module-a planning service.

The map preview remains standard-library-only. Its child process uses module-a's
isolated virtual environment. No credentials or arbitrary upstream URLs cross
this bridge. Prepared previews supply only genuine, directed Baidu route legs.
"""
from __future__ import annotations

import argparse
from http.client import HTTPConnection, HTTPException
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
MODULE_ROOT = ROOT.parent / 'module-a'
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
RESOURCE = r'[A-Za-z0-9_-]{1,100}'
API_PATHS = {
    'GET': [r'/health', r'/api/v1/(places|routes|tools|model-status|chat|dynamic-state)',
            rf'/api/v1/places/{RESOURCE}', rf'/api/v1/routes/{RESOURCE}',
            rf'/api/v1/routes/{RESOURCE}/assessment'],
    'POST': [r'/api/v1/(demo/sessions|demo/events|routes|route-options|tools/call|chat|intents/resolve)',
             rf'/api/v1/routes/{RESOURCE}/(start|progress|replan|accept)'],
    'PUT': [r'/api/v1/position', rf'/api/v1/routes/{RESOURCE}/favorite'],
}


def allowed_endpoint(method, path):
    return any(re.fullmatch(pattern, path) for pattern in API_PATHS.get(method, ()))


def read_preview(module_root=MODULE_ROOT):
    """Parse a strict JSON assignment, never execute the bundled JavaScript."""
    raw = (Path(module_root) / 'miniprogram/data/preview.js').read_text(encoding='utf-8-sig').strip()
    prefix = 'module.exports = '
    if not raw.startswith(prefix) or not raw.endswith(';'):
        raise ValueError('Unsupported prepared-preview format')
    snapshot = json.loads(raw[len(prefix):-1])
    if snapshot.get('mode') != 'prepared_preview':
        raise ValueError('Expected a source-labelled prepared preview')
    return snapshot


def seed_prepared_data(settings, module_root=MODULE_ROOT):
    """Recover only matching real places/legs, without replacing existing data."""
    from app.maps.segments import SegmentRepository
    from app.schemas import Place, WalkingLeg
    from app.storage.database import Database

    snapshot = read_preview(module_root)
    preview_places = {p.place_id: p for p in (Place.model_validate(p) for p in snapshot['places'])}
    settings.places_path.parent.mkdir(parents=True, exist_ok=True)
    if not settings.places_path.exists():
        settings.places_path.write_text(json.dumps([p.model_dump(mode='json') for p in preview_places.values()],
            ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    places = [Place.model_validate(p) for p in json.loads(settings.places_path.read_text(encoding='utf-8-sig'))]
    by_id = {p.place_id: p for p in places}
    database = Database(settings.database_path)
    database.seed_places(places)
    imported = 0
    for option in snapshot.get('options', []):
        for raw in option.get('legs', []):
            leg = WalkingLeg.model_validate(raw)
            ids = [leg.from_place_id, leg.to_place_id]
            if leg.source != 'baidu_walking' or any(pid not in by_id or pid not in preview_places for pid in ids):
                continue
            if any((by_id[pid].longitude, by_id[pid].latitude, by_id[pid].entrance_version) !=
                   (preview_places[pid].longitude, preview_places[pid].latitude, preview_places[pid].entrance_version)
                   for pid in ids):
                continue
            key = SegmentRepository.cache_key(*(by_id[pid] for pid in ids))
            if not database.segment(key):
                database.save_segment(key, leg)
                imported += 1
    return {'places': len(places), 'imported_segments': imported,
            'cached_segments': database.segment_count(), 'expected_segments': len(places) * (len(places) - 1)}


def _worker_settings():
    sys.path.insert(0, str(MODULE_ROOT / 'backend'))
    from fetch_scene import load_dotenv
    from app.config import Settings
    # The service credential stays in the worker process, never in a browser.
    load_dotenv(ROOT / '.env')
    settings = Settings.load()
    if not settings.baidu_ak and os.environ.get('BAIDU_MAP_AK'):
        from dataclasses import replace
        settings = replace(settings, baidu_ak=os.environ['BAIDU_MAP_AK'])
    return settings


async def prepare_live(settings):
    """Fill missing directed routes through the authorised Baidu Web service."""
    import httpx
    from app.errors import AppError
    from app.maps.baidu import BaiduMaps
    from app.maps.segments import SegmentRepository
    from app.storage.database import Database
    report = seed_prepared_data(settings)
    database = Database(settings.database_path)
    places = database.places()
    failures = []
    async with httpx.AsyncClient(base_url=settings.maps_base_url, follow_redirects=False,
            timeout=httpx.Timeout(15, connect=5)) as client:
        provider = BaiduMaps(client, settings.baidu_ak)
        segments = SegmentRepository(database, provider, 'baidu')
        for origin in places:
            for target in places:
                if origin.place_id == target.place_id:
                    continue
                try:
                    await segments.get(origin, target)
                except AppError as error:
                    failures.append({'from_place_id': origin.place_id, 'to_place_id': target.place_id,
                                     'code': error.code, 'details': error.details})
                    # An auth/network outage is systemic; do not burn the full graph quota.
                    if error.code != 'WALKING_UNREACHABLE':
                        report.update(cached_segments=database.segment_count(), upstream_calls=provider.calls, failures=failures)
                        return report
        report.update(cached_segments=database.segment_count(), upstream_calls=provider.calls, failures=failures)
    return report


class PlanningBackend:
    """Lazy child-process lifecycle plus a fixed-loopback HTTP transport."""
    def __init__(self, module_root=MODULE_ROOT):
        self.module_root = Path(module_root)
        self.process = None
        self.port = None
        self.lock = threading.Lock()

    def start(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                return
            python = self.module_root / 'backend/.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            if not python.exists():
                raise RuntimeError('请先运行 module-a 后端依赖安装，路线服务尚未启动。')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                self.port = listener.getsockname()[1]
            self.process = subprocess.Popen([str(python), str(Path(__file__).resolve()), '--worker', '--port', str(self.port)],
                cwd=str(ROOT.parent), env=os.environ.copy(), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    break
                try:
                    with socket.create_connection(('127.0.0.1', self.port), timeout=.2):
                        return
                except OSError:
                    time.sleep(.1)
            self.stop()
            raise RuntimeError('路线服务启动失败，请检查 module-a 后端依赖和本地数据。')

    def request(self, method, path, headers=None, body=None):
        self.start()
        connection = HTTPConnection('127.0.0.1', self.port, timeout=50)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            content = response.read(MAX_RESPONSE_BYTES + 1)
            if len(content) > MAX_RESPONSE_BYTES:
                raise RuntimeError('路线服务返回内容过大。')
            return response.status, response.getheader('Content-Type', 'application/json'), content
        except (OSError, HTTPException):
            raise RuntimeError('路线服务暂时不可用，请重试；当前地图与交子仍可使用。') from None
        finally:
            connection.close()

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.process = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--prepare-live', action='store_true')
    parser.add_argument('--port', type=int, default=8004)
    args = parser.parse_args()
    settings = _worker_settings()
    if args.prepare_live:
        import asyncio
        report = asyncio.run(prepare_live(settings))
        (MODULE_ROOT / 'runtime/map-integration-preparation.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
        return 0 if not report.get('failures') else 1
    seed_prepared_data(settings)
    import uvicorn
    from app.main import create_app
    uvicorn.run(create_app(settings), host='127.0.0.1', port=args.port, log_level='warning', access_log=False)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
