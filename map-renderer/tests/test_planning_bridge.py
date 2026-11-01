"""Integration boundaries for same-origin planner requests (no external calls)."""
from http.client import HTTPConnection
import json
from pathlib import Path
import sys
from threading import Thread
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from planning_backend import allowed_endpoint, read_preview
from serve import create_server


class FakeBackend:
    def __init__(self):
        self.calls = []

    def request(self, method, path, headers=None, body=None):
        self.calls.append((method, path, headers, body))
        return 409, 'application/json', b'{"error":{"code":"STALE_REVISION"}}'


class PlanningProxyTests(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.server = create_server(0, planning_backend=self.backend)
        self.worker = Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=5)

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read(), response.headers
        finally:
            connection.close()

    def test_known_write_preserves_version_conflict_and_session(self):
        status, body, headers = self.request('POST', '/planning/api/v1/routes/route_1/accept',
            '{"base_revision":1,"proposal_id":"p_1"}', {'Content-Type': 'application/json',
            'X-Demo-Session': 'local-test-session', 'Authorization': 'must-not-forward'})
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)['error']['code'], 'STALE_REVISION')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        method, path, forwarded, payload = self.backend.calls[0]
        self.assertEqual(path, '/api/v1/routes/route_1/accept')
        self.assertEqual(forwarded['X-Demo-Session'], 'local-test-session')
        self.assertNotIn('Authorization', forwarded)
        self.assertEqual(json.loads(payload)['proposal_id'], 'p_1')

    def test_cross_origin_requests_do_not_reach_backend(self):
        status, _, _ = self.request('POST', '/planning/api/v1/demo/sessions', '{}',
            {'Content-Type': 'application/json', 'Origin': 'https://unrelated.example'})
        self.assertEqual(status, 403)
        self.assertEqual(self.backend.calls, [])

    def test_private_paths_and_unknown_upstream_routes_are_not_proxied(self):
        for path in ['/planning/.env', '/planning/api/v1/../config.json', '/planning/docs',
                     '/planning/http://unrelated.example', '/planning/api/v1/routes/a%2fb']:
            status, _, _ = self.request('GET', path)
            self.assertEqual(status, 404, path)
        self.assertEqual(self.backend.calls, [])

    def test_non_json_and_large_bodies_are_rejected(self):
        status, _, _ = self.request('PUT', '/planning/api/v1/position', '{}')
        self.assertEqual(status, 415)
        status, _, _ = self.request('POST', '/planning/api/v1/chat', '',
            {'Content-Type': 'application/json', 'Content-Length': str(1024 * 1024 + 1)})
        self.assertEqual(status, 413)
        self.assertEqual(self.backend.calls, [])

    def test_place_query_is_kept_and_host_is_not_forwarded(self):
        self.request('GET', '/planning/api/v1/places?category=coffee&radius_m=1500')
        self.assertEqual(self.backend.calls[0][1], '/api/v1/places?category=coffee&radius_m=1500')
        self.assertNotIn('Host', self.backend.calls[0][2])


class PlannerContractTests(unittest.TestCase):
    def test_all_supported_capability_paths_are_available(self):
        examples = {
            'GET': ['/health', '/api/v1/places', '/api/v1/places/ifs', '/api/v1/routes',
                    '/api/v1/routes/route_1', '/api/v1/routes/route_1/assessment', '/api/v1/tools',
                    '/api/v1/model-status', '/api/v1/chat', '/api/v1/dynamic-state'],
            'POST': ['/api/v1/demo/sessions', '/api/v1/demo/events', '/api/v1/route-options',
                     '/api/v1/routes', '/api/v1/chat', '/api/v1/intents/resolve', '/api/v1/tools/call',
                     *['/api/v1/routes/route_1/' + action for action in ['start', 'progress', 'replan', 'accept']]],
            'PUT': ['/api/v1/position', '/api/v1/routes/route_1/favorite'],
        }
        for method, paths in examples.items():
            for path in paths:
                self.assertTrue(allowed_endpoint(method, path), (method, path))
        self.assertFalse(allowed_endpoint('DELETE', '/api/v1/routes/route_1'))

    def test_preview_contains_only_existing_source_labelled_routes(self):
        snapshot = read_preview()
        self.assertEqual(len(snapshot['places']), 9)
        self.assertEqual({p['coord_system'] for p in snapshot['places']}, {'gcj02'})
        for option in snapshot['options']:
            for leg in option['legs']:
                self.assertEqual(leg['source'], 'baidu_walking')
                self.assertTrue(leg['points'])


if __name__ == '__main__':
    unittest.main()
