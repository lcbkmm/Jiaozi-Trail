import json
import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.maps.segments import SegmentRepository
from app.storage.database import Database




def test_session_route_favorite_start_and_ownership(api):
    client,payload,app=api
    created=client.post("/api/v1/routes",json=payload)
    assert created.status_code==201,created.text
    route=created.json()["data"];route_id=route["route_id"]
    assert app.state.maps.calls==0
    assert client.put(f"/api/v1/routes/{route_id}/favorite",json={"favorite":True}).json()["data"]["is_favorite"]
    assert len(client.get("/api/v1/routes?favorite=true").json()["data"])==1
    assert client.post(f"/api/v1/routes/{route_id}/start",json={"base_revision":99}).status_code==409
    started=client.post(f"/api/v1/routes/{route_id}/start",json={"base_revision":1}).json()["data"]
    assert started["revision"]==2 and started["status"]=="active"
    assert client.post(f"/api/v1/routes/{route_id}/start",json={"base_revision":1}).json()["data"]["revision"]==2
    assert client.get(f"/api/v1/routes/{route_id}").json()["data"]["is_favorite"]
    other=client.post("/api/v1/demo/sessions",json={}).json()["data"]["session_token"]
    assert client.get(f"/api/v1/routes/{route_id}",headers={"X-Demo-Session":other}).status_code==404
    assert client.get("/api/v1/routes",headers={"X-Demo-Session":other}).json()["data"]==[]


def test_validation_and_unknown_place(api):
    client,payload,app=api
    assert client.get("/api/v1/places?longitude=104.08").status_code==422
    assert client.get("/api/v1/places?longitude=nan&latitude=30").status_code==422
    assert client.get("/api/v1/places",headers={"X-Demo-Session":"invalid"}).status_code==401
    payload["start_place_id"]="missing"
    assert client.post("/api/v1/routes",json=payload).json()["error"]["code"]=="INVALID_INPUT"


def test_routes_survive_reopening_database(api):
    client,payload,app=api
    route=client.post("/api/v1/routes",json=payload).json()["data"]
    db=Database(app.state.database.path)
    token=client.headers["X-Demo-Session"]
    assert db.route(token,route["route_id"])["totals"]==route["totals"]
    assert client.get("/").status_code==200
    assert client.get("/health").json()["places_count"]==4


@pytest.mark.parametrize("failure_code,expected_status",[("WALKING_UNREACHABLE",422),("MAP_UNAVAILABLE",503)])
def test_known_unreachable_is_distinct_from_upstream_failure(api,failure_code,expected_status):
    client,payload,app=api
    async def failed_graph(places):
        return {},[{"from_place_id":"start","to_place_id":"coffee","code":failure_code,"details":{}}]
    app.state.segments.graph=failed_graph
    response=client.post("/api/v1/routes",json=payload)
    assert response.status_code==expected_status
