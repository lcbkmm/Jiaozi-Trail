from datetime import datetime, timezone
import pytest
from app.schemas import CampaignStop, Place, Point, Preferences, WalkingLeg


@pytest.fixture
def sample():
    # Synthetic unit-test inputs; never loaded into the demo dataset.
    now = datetime(2026, 10, 31, 6, tzinfo=timezone.utc)
    places = [Place(place_id=pid, name=pid, address="test fixture", uid="test_"+pid,
              longitude=104.08+i*.001, latitude=30.65, category=category, retrieved_at=now)
              for i, (pid, category) in enumerate([("start","start"),("coffee","coffee"),("meal","meal"),("temple","culture")])]
    stops = [CampaignStop(stop_id="stop_"+pid, place_id=pid, title="test", category=category,
              interests=[interest], dwell_s=dwell, cost_min_fen=low, cost_max_fen=high,
              queue_s=60, windows=[{"opens":"10:00", "closes":"21:00"}])
              for pid, category, interest, dwell, low, high in [
              ("coffee","coffee","coffee",600,2000,3000),
              ("meal","meal","food",1200,4000,6000),
              ("temple","culture","culture",900,0,0)]]
    graph = {(a.place_id,b.place_id): WalkingLeg(from_place_id=a.place_id,to_place_id=b.place_id,
             distance_m=100,duration_s=180,points=[Point(longitude=p.longitude,latitude=p.latitude) for p in (a,b)],
             retrieved_at=now,entrance_version="1:1") for a in places for b in places if a!=b}
    preferences = Preferences(start_place_id="start", departure_at="2026-10-31T14:00:00+08:00",
                max_duration_s=7200,budget_per_person_fen=10000,interests=["coffee","food","culture"])
    return places, stops, graph, preferences

import json
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.maps.segments import SegmentRepository
from app.storage.database import Database

@pytest.fixture
def api(tmp_path,sample):
    places,stops,graph,pref=sample
    place_path=tmp_path/"places.json";campaign_path=tmp_path/"campaign.json"
    place_path.write_text(json.dumps([p.model_dump(mode="json") for p in places]),encoding="utf-8")
    campaign_path.write_text(json.dumps({"stops":[s.model_dump(mode="json") for s in stops]}),encoding="utf-8")
    settings=Settings(database_path=tmp_path/"test.sqlite3",places_path=place_path,campaign_path=campaign_path,maps_mode="prepared")
    database=Database(settings.database_path)
    for (a,b),leg in graph.items():
        database.save_segment(SegmentRepository.cache_key(next(p for p in places if p.place_id==a),next(p for p in places if p.place_id==b)),leg)
    app=create_app(settings)
    with TestClient(app) as client:
        response=client.post("/api/v1/demo/sessions",json={})
        client.headers["X-Demo-Session"]=response.json()["data"]["session_token"]
        yield client,pref.model_dump(mode="json"),app

