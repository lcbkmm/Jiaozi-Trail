"""Validate exact recovery of genuine cached legs, with no network calls."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT.parent / 'module-a/backend'))


@unittest.skipUnless(importlib.util.find_spec('fastapi'), 'Run with module-a/backend/.venv Python')
class PreparedDataRecoveryTests(unittest.TestCase):
    def test_only_available_directed_baidu_legs_are_imported(self):
        from app.config import Settings
        from app.maps.segments import SegmentRepository
        from app.storage.database import Database
        from planning_backend import read_preview, seed_prepared_data
        snapshot = read_preview()
        exact_pairs = {(leg['from_place_id'], leg['to_place_id'])
                       for option in snapshot['options'] for leg in option['legs']}
        with tempfile.TemporaryDirectory() as folder:
            settings = Settings(database_path=Path(folder) / 'db.sqlite3', places_path=Path(folder) / 'places.json')
            report = seed_prepared_data(settings)
            self.assertEqual(report['cached_segments'], len(exact_pairs))
            self.assertEqual(seed_prepared_data(settings)['imported_segments'], 0)
            database = Database(settings.database_path)
            places = {place.place_id: place for place in database.places()}
            for a in places.values():
                for b in places.values():
                    cached = database.segment(SegmentRepository.cache_key(a, b))
                    self.assertEqual(cached is not None, (a.place_id, b.place_id) in exact_pairs)

    def test_changed_catalog_coordinates_are_not_overwritten_or_reused(self):
        from app.config import Settings
        from app.storage.database import Database
        from planning_backend import read_preview, seed_prepared_data
        snapshot = read_preview()
        with tempfile.TemporaryDirectory() as folder:
            settings = Settings(database_path=Path(folder) / 'db.sqlite3', places_path=Path(folder) / 'places.json')
            places = snapshot['places']
            for place in places:
                place['longitude'] += .001
            original = json.dumps(places, ensure_ascii=False)
            settings.places_path.write_text(original, encoding='utf-8')
            report = seed_prepared_data(settings)
            self.assertEqual(report['cached_segments'], 0)
            self.assertEqual(settings.places_path.read_text(encoding='utf-8'), original)
            self.assertEqual(Database(settings.database_path).places()[0].longitude, places[0]['longitude'])


if __name__ == '__main__':
    unittest.main()
