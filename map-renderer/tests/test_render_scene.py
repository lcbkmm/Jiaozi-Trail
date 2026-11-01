import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

spec = importlib.util.spec_from_file_location('render_scene', Path(__file__).resolve().parents[1] / 'scripts/render_scene.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class RenderTests(unittest.TestCase):
    def test_empty_geometry_does_not_create_a_fake_map(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'map'
            with self.assertRaisesRegex(ValueError, 'road and building'):
                renderer.render_scene({'bbox': [104.07, 30.65, 104.08, 30.66], 'features': []}, output)
            self.assertFalse(output.exists())

    def test_projection_has_correct_cardinal_directions(self):
        projection = renderer.Projection([104.07, 30.65, 104.08, 30.66], 600, 800, azimuth=0)
        center = [104.075, 30.655]
        x, y = projection.point(center)
        self.assertGreater(projection.point([104.076, center[1]])[0], x)
        self.assertLess(projection.point([center[0], 30.656])[1], y)
        self.assertLess(projection.point(center, 20)[1], y)

    def test_export_hotspots_and_image_share_the_same_projection(self):
        # Deliberately synthetic tiny geometry, only for export validation.
        scene = {'bbox': [104.07, 30.65, 104.08, 30.66], 'features': [
            {'type': 'Feature', 'properties': {'kind': 'building', 'osm_id': 'fixture', 'height_m': None},
             'geometry': {'type': 'Polygon', 'coordinates': [[[104.074, 30.654], [104.076, 30.654], [104.076, 30.656], [104.074, 30.656], [104.074, 30.654]]]}},
            {'type': 'Feature', 'properties': {'kind': 'road', 'tags': {'highway': 'pedestrian'}},
             'geometry': {'type': 'LineString', 'coordinates': [[104.071, 30.651], [104.079, 30.659]]}},
            {'type': 'Feature', 'properties': {'kind': 'poi', 'name': 'TEST ONLY', 'source': 'fixture'},
             'geometry': {'type': 'Point', 'coordinates': [104.075, 30.655]}},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            report = renderer.render_scene(scene, output, 600, 800)
            self.assertEqual(report['buildingHeightSources'], {'visual_estimate': 1})
            with Image.open(output / 'chunxi-map.png') as image:
                self.assertEqual(image.size, (600, 800))
            data = json.loads((output / 'chunxi-map.hotspots.json').read_text(encoding='utf-8'))
            p = data['hotspots'][0]
            expected = renderer.Projection(scene['bbox'], 600, 800).point([104.075, 30.655])
            self.assertAlmostEqual(p['pixel'][0], expected[0], places=2)
            self.assertAlmostEqual(p['pixel'][1], expected[1], places=2)
            self.assertAlmostEqual(p['normalized'][0] * 600, p['pixel'][0], places=2)
            self.assertTrue((output / 'chunxi-map.webp').exists())


if __name__ == '__main__':
    unittest.main()
