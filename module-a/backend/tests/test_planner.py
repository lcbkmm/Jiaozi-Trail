from datetime import datetime
import pytest
from pydantic import ValidationError
from app.errors import AppError
from app.planner.search import search_routes
from app.schemas import Preferences, TimeWindow


def test_totals_budget_and_timestamps_are_consistent(sample):
    places, stops, graph, preferences = sample
    route = search_routes(preferences, places, stops, graph)
    totals=route["totals"]
    assert totals["duration_s"] == sum(totals[k] for k in ["walk_duration_s","wait_duration_s","queue_duration_s","dwell_duration_s","buffer_s"])
    assert (datetime.fromisoformat(route["planned_end_at"])-preferences.departure_at).total_seconds()==totals["duration_s"]
    assert totals["duration_s"]<=preferences.max_duration_s
    assert totals["cost_max_per_person_fen"]<=preferences.budget_per_person_fen
    assert len({s["place_id"] for s in route["stops"]})==len(route["stops"])


def test_required_place_cannot_be_silently_removed_for_budget(sample):
    places, stops, graph, pref=sample
    pref= pref.model_copy(update={"must_visit_ids":["meal"],"budget_per_person_fen":5000})
    with pytest.raises(AppError) as caught:
        search_routes(pref, places, stops, graph)
    assert caught.value.code=="NO_FEASIBLE_ROUTE"
    assert caught.value.details["conflicts"]["budget_limit"]>0


def test_wait_for_next_open_window_counts_toward_total(sample):
    places, stops, graph, pref=sample
    target=stops[0].model_copy(update={"windows":[TimeWindow(opens="15:00",closes="17:00")]})
    pref=pref.model_copy(update={"must_visit_ids":["coffee"]})
    route=search_routes(pref, places, [target], graph)
    assert route["stops"][0]["wait_duration_s"]==3420
    assert route["stops"][0]["experience_start_at"]=="2026-10-31T15:01:00+08:00"


def test_lunch_break_is_not_treated_as_open(sample):
    places, stops, graph, pref=sample
    target=stops[0].model_copy(update={"windows":[TimeWindow(opens="11:00",closes="12:00"),TimeWindow(opens="14:00",closes="15:00")]})
    pref=pref.model_copy(update={"departure_at":datetime.fromisoformat("2026-10-31T12:30:00+08:00"),"max_duration_s":10800})
    route=search_routes(pref,places,[target],graph)
    assert route["stops"][0]["experience_start_at"]=="2026-10-31T14:01:00+08:00"


def test_closing_time_includes_queue_and_dwell(sample):
    places, stops, graph, pref=sample
    target=stops[0].model_copy(update={"windows":[TimeWindow(opens="10:00",closes="14:10")]})
    with pytest.raises(AppError):search_routes(pref,places,[target],graph)


def test_return_leg_and_buffer_cannot_be_omitted(sample):
    places,stops,graph,pref=sample
    graph[("coffee","start")]=graph[("coffee","start")].model_copy(update={"duration_s":3600})
    pref=pref.model_copy(update={"max_duration_s":1800,"end_place_id":"start","must_visit_ids":["coffee"]})
    with pytest.raises(AppError):search_routes(pref,places,[stops[0]],graph)


def test_walk_limit_and_required_place_are_both_hard_constraints(sample):
    places,stops,graph,pref=sample
    pref=pref.model_copy(update={"max_walk_m":0,"must_visit_ids":["coffee"]})
    with pytest.raises(AppError):search_routes(pref,places,stops,graph)


def test_missing_paths_are_not_replaced_by_straight_lines(sample):
    places,stops,graph,pref=sample
    with pytest.raises(AppError) as caught:search_routes(pref,places,stops,{})
    assert caught.value.details["conflicts"]["missing_walking_leg"]>0


def test_unavailable_required_place_is_reported(sample):
    places,stops,graph,pref=sample
    stops[1]=stops[1].model_copy(update={"status":"closed"})
    pref=pref.model_copy(update={"must_visit_ids":["meal"]})
    with pytest.raises(AppError) as caught:search_routes(pref,places,stops,graph)
    assert caught.value.code=="NO_FEASIBLE_ROUTE"


def test_input_requires_timezone_and_finite_coordinates(sample):
    places,stops,graph,pref=sample
    data=pref.model_dump(mode="json");data["departure_at"]="2026-10-31T14:00:00"
    with pytest.raises(ValidationError):Preferences.model_validate(data)
    data=pref.model_dump(mode="json");data["budget_per_person_fen"]=-1
    with pytest.raises(ValidationError):Preferences.model_validate(data)


def test_short_route_does_not_repeat_drink_stops(sample):
    places,stops,graph,pref=sample
    stops[1]=stops[1].model_copy(update={"category":"tea","interests":["tea"],"cost_min_fen":1000,"cost_max_fen":2000})
    route=search_routes(pref,places,stops,graph)
    assert sum(s["category"] in {"coffee","tea"} for s in route["stops"])<=1
