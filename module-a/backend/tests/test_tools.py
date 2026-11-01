import pytest
from app.planner.search import search_routes
from app.schemas import Preferences


def test_options_are_unique_feasible_and_reproducible(sample):
    places,stops,graph,pref=sample
    result=search_routes(pref,places,stops,graph,include_options=True)
    assert 1<=len(result["options"])<=3
    assert result["options"][0]["recommended"]
    seen=[]
    for option in result["options"]:
        selected=frozenset(s["place_id"] for s in option["stops"])
        assert selected not in seen;seen.append(selected)
        assert option["totals"]["duration_s"]<=pref.max_duration_s
        assert option["totals"]["cost_max_per_person_fen"]<=pref.budget_per_person_fen
        saved=search_routes(Preferences.model_validate(option["preferences"]),places,stops,graph)
        assert saved["stop_ids"]==option["stop_ids"]


def test_more_than_one_style_uses_one_graph_and_does_not_save_routes(api):
    client,payload,app=api
    original=app.state.segments.graph
    calls=[]
    async def counted(points):
        calls.append(1)
        return await original(points)
    app.state.segments.graph=counted
    response=client.post("/api/v1/route-options",json=payload)
    assert response.status_code==200,response.text
    assert len(calls)==1
    assert app.state.maps.calls==0
    assert client.get("/api/v1/routes").json()["data"]==[]
    for option in response.json()["data"]["options"]:
        assert option["preferences"]["planning_style"]==option["option_id"]
        saved=client.post("/api/v1/routes",json=option["preferences"]).json()["data"]
        assert saved["stop_ids"]==option["stop_ids"]


def test_tool_registry_uses_validated_whitelist(api):
    client,payload,app=api
    data=client.get("/api/v1/tools").json()["data"]
    assert data["agent_connected"] is False
    assert {tool["name"] for tool in data["tools"]}=={"get_place_details","search_nearby_places","plan_route_options"}
    assert client.post("/api/v1/tools/call",json={"name":"arbitrary_python","arguments":{}}).status_code==422
    assert client.post("/api/v1/tools/call",json={"name":"get_place_details","arguments":{"place_id":"coffee","fake":True}}).status_code==422
    detail=client.post("/api/v1/tools/call",json={"name":"get_place_details","arguments":{"place_id":"coffee"}}).json()["data"]
    assert detail["queue"]["source"]=="demo"
    assert detail["crowd_density"]["value"] is None
    assert detail["crowd_density"]["source"]=="unavailable"
    assert client.get("/api/v1/places/no_such_place").status_code==404
    result=client.post("/api/v1/tools/call",json={"name":"plan_route_options","arguments":payload})
    assert result.status_code==200,result.text
    assert result.json()["data"]["shared_walking_graph"] is True
    assert client.get("/api/v1/routes").json()["data"]==[]
