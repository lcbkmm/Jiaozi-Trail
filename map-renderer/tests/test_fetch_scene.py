"""Offline fixtures: geometry correctness, API failures, and credential handling."""

import importlib.util
import io
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'fetch_scene.py'
spec = importlib.util.spec_from_file_location('fetch_scene', SCRIPT)
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)


def geometry(points):
    return [{'lon': x, 'lat': y} for x, y in points]


def way(identifier, points, tags):
    return {'type': 'way', 'id': identifier, 'tags': tags, 'geometry': geometry(points)}


def member(identifier, points, role='outer'):
    return {'type': 'way', 'ref': identifier, 'role': role, 'geometry': geometry(points)}


class FetchSceneTests(unittest.TestCase):
    def test_bbox_order_and_invalid_values(self):
        query = fetch.overpass_query([104.07, 30.65, 104.08, 30.66])
        self.assertIn('(30.65000000,104.07000000,30.66000000,104.08000000)', query)
        for bbox in ([104, 31, 103, 32], [104, math.nan, 105, 32], [104, 30, 105, 31], [181, 30, 182, 31]):
            with self.subTest(bbox=bbox), self.assertRaises(fetch.FetchError):
                fetch.validate_bbox(bbox)

    def test_building_and_road_preserve_geometry_and_height_provenance(self):
        square = [(104.07, 30.65), (104.071, 30.65), (104.071, 30.651), (104.07, 30.651), (104.07, 30.65)]
        collection = fetch.normalize_overpass({'elements': [
            way(1, square, {'building': 'yes', 'building:levels': '5', 'name': '测试楼'}),
            way(2, [(104.07, 30.65), (104.08, 30.66)], {'highway': 'pedestrian', 'name': '测试道路'}),
        ]})
        building, road = collection['features']
        self.assertEqual(building['geometry']['type'], 'Polygon')
        self.assertEqual(building['properties']['height_m'], 15)
        self.assertEqual(building['properties']['height_source'], 'estimated_from_levels_3m')
        self.assertEqual(road['geometry']['type'], 'LineString')
        self.assertEqual(road['geometry']['coordinates'][0], [104.07, 30.65])
        self.assertEqual(collection['bbox'], [104.07, 30.65, 104.08, 30.66])

    def test_multipolygon_stitches_reversed_members_and_preserves_hole(self):
        outer_a = [(0, 0), (0.01, 0), (0.01, 0.01)]
        outer_b = [(0, 0), (0, 0.01), (0.01, 0.01)]  # Reversed joining direction.
        hole = [(0.002, 0.002), (0.003, 0.002), (0.003, 0.003), (0.002, 0.003), (0.002, 0.002)]
        payload = {'elements': [
            way(10, outer_a, {'building': 'yes'}),
            {'type': 'relation', 'id': 1, 'tags': {'building': 'yes', 'type': 'multipolygon'},
             'members': [member(11, outer_b), member(12, hole, 'inner'), member(10, outer_a)]},
        ]}
        collection = fetch.normalize_overpass(payload)
        self.assertEqual(len(collection['features']), 1)  # Member way is not rendered twice.
        shape = collection['features'][0]['geometry']
        self.assertEqual(shape['type'], 'Polygon')
        self.assertEqual(len(shape['coordinates']), 2)
        self.assertGreater(fetch._signed_area(shape['coordinates'][0]), 0)
        self.assertLess(fetch._signed_area(shape['coordinates'][1]), 0)

    def test_multiple_outer_polygons_assign_hole_to_correct_outer(self):
        outer1 = [(0, 0), (0.01, 0), (0.01, 0.01), (0, 0.01), (0, 0)]
        outer2 = [(0.02, 0), (0.03, 0), (0.03, 0.01), (0.02, 0.01), (0.02, 0)]
        hole = [(0.022, 0.002), (0.023, 0.002), (0.023, 0.003), (0.022, 0.003), (0.022, 0.002)]
        payload = {'elements': [{'type': 'relation', 'id': 2, 'tags': {'landuse': 'residential'},
                                'members': [member(1, outer1), member(2, outer2), member(3, hole, 'inner')]}]}
        shape = fetch.normalize_overpass(payload)['features'][0]['geometry']
        self.assertEqual(shape['type'], 'MultiPolygon')
        self.assertEqual([len(polygon) for polygon in shape['coordinates']], [1, 2])

    def test_incomplete_geometry_and_upstream_errors_never_make_fake_shapes(self):
        cases = [
            {'elements': []}, {}, {'elements': [], 'remark': 'runtime error: timeout'},
            {'elements': [way(1, [(0, 0), (0.01, 0), (0.01, 0.01)], {'building': 'yes'})]},
            {'elements': [{'type': 'way', 'id': 2, 'tags': {'highway': 'footway'}, 'geometry': [None]}]},
        ]
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(fetch.FetchError):
                fetch.normalize_overpass(payload)

    def test_coordinate_inverse_and_known_bd09_conversion(self):
        gcj = fetch.bd09_to_gcj02(116.41036949371029, 39.92133699351021)
        self.assertAlmostEqual(gcj[0], 116.404, places=5)
        self.assertAlmostEqual(gcj[1], 39.915, places=5)
        original = (104.078, 30.655)
        recovered = fetch.gcj02_to_wgs84(*fetch.wgs84_to_gcj02(*original))
        self.assertAlmostEqual(recovered[0], original[0], places=8)
        self.assertAlmostEqual(recovered[1], original[1], places=8)
        self.assertEqual(fetch.gcj02_to_wgs84(-74, 40), (-74, 40))

    def test_baidu_payload_error_empty_results_and_no_fabricated_location(self):
        with self.assertRaisesRegex(fetch.FetchError, 'status 302'):
            fetch.normalize_baidu({'status': 302, 'message': 'AK invalid'}, '春熙路')
        self.assertEqual(fetch.normalize_baidu({'status': 0, 'results': []}, '春熙路')[0], [])
        with self.assertRaises(fetch.FetchError):
            fetch.normalize_baidu({'status': 0, 'results': [{'name': '没有坐标'}]}, '春熙路')
        features, report = fetch.normalize_baidu({'status': 0, 'total': 21, 'results': [
            {'name': '春熙路', 'uid': 'abc', 'city': '成都市', 'area': '锦江区', 'location': {'lng': 104.09, 'lat': 30.66}}
        ]}, '春熙路')
        self.assertEqual(features[0]['properties']['source_crs'], 'BD09LL')
        self.assertFalse(report['all_pages_downloaded'])
        self.assertNotEqual(features[0]['geometry']['coordinates'], [104.09, 30.66])
        self.assertEqual(fetch.choose_chunxi_center(features), features[0])
        features[0]['properties']['city'] = '北京市'
        with self.assertRaises(fetch.FetchError):
            fetch.choose_chunxi_center(features)

    def test_key_used_for_request_but_not_persisted_or_echoed(self):
        secret = 'private-fixture-key'
        requests = []

        def opener(request, timeout):
            requests.append(request.full_url)
            return io.BytesIO(json.dumps({'status': 0, 'results': []}).encode())

        features, reports = fetch.fetch_baidu(secret, queries=['春熙路'], opener=opener)
        self.assertIn('ak=' + secret, requests[0])
        self.assertNotIn(secret, json.dumps([features, reports]))

        def failing_opener(request, timeout):
            return io.BytesIO(json.dumps({'status': 302, 'message': 'bad AK ' + secret}).encode())

        with self.assertRaises(fetch.FetchError) as context:
            fetch.fetch_baidu(secret, queries=['春熙路'], opener=failing_opener)
        self.assertNotIn(secret, str(context.exception))
        self.assertIn('[REDACTED]', str(context.exception))

    def test_dotenv_literals_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'BAIDU_MAP_AK': 'environment-key'}):
            dotenv = Path(directory) / '.env'
            dotenv.write_text('# comment\nBAIDU_MAP_AK=file-key\nFETCH_FIXTURE="literal $VALUE"\n', encoding='utf-8')
            fetch.load_dotenv(dotenv)
            self.assertEqual(os.environ['BAIDU_MAP_AK'], 'environment-key')
            self.assertEqual(os.environ['FETCH_FIXTURE'], 'literal $VALUE')


if __name__ == '__main__':
    unittest.main()
