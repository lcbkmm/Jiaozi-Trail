"""Regressions for the Nov 1 demonstration: goals, progress, bounded queries."""
import asyncio
from datetime import datetime, timedelta
from unittest.mock import AsyncMock
import pytest
from pydantic import ValidationError
from app.errors import AppError
from app.planner.search import search_routes
from app.schemas import Place, Preferences
from app.maps.segments import SegmentRepository
from app.storage.database import Database
from test_intent import install_parser, update


def test_every_option_must_fulfil_hotpot_goal(sample):
    places,stops,graph,pref=sample
    stops[1]=stops[1].model_copy(update={'interests':['food','hotpot']})
    pref=pref.model_copy(update={'required_experiences':['hotpot']})
    result=search_routes(pref,places,stops,graph,include_options=True)
    assert result['options']
    for option in result['options']:
        assert 'meal' in [s['place_id'] for s in option['stops']]
        assert next(s for s in option['stops'] if s['place_id']=='meal')['recommendation']=='满足核心需求：火锅'
        assert option['totals']['cost_max_per_person_fen']<=pref.budget_per_person_fen


def test_focused_goal_allows_single_stop_even_with_other_affordable_visits(sample):
    places,stops,graph,pref=sample
    pref=pref.model_copy(update={'required_experiences':['food'],'visit_mode':'focused'})
    result=search_routes(pref,places,stops,graph,include_options=True)
    assert all([s['place_id'] for s in o['stops']]==['meal'] for o in result['options'])
    pref=pref.model_copy(update={'must_visit_ids':['temple']})
    assert set(search_routes(pref,places,stops,graph)['stop_ids'])=={'stop_meal','stop_temple'}


def test_missing_goal_and_required_exclusion_are_never_silently_relaxed(sample):
    places,stops,graph,pref=sample
    with pytest.raises(AppError) as error:
        search_routes(pref.model_copy(update={'required_experiences':['hotpot']}),places,stops,graph)
    assert error.value.code=='NO_FEASIBLE_ROUTE'
    assert error.value.details['missing_required_experiences']==['hotpot']
    with pytest.raises(ValidationError):
        Preferences.model_validate({**pref.model_dump(),'required_experiences':['food'],'excluded_interests':['food']})


def test_chat_goal_is_carried_to_saved_route_and_missing_budget_has_reason(api):
    client,pref,app=api
    install_parser(app,[{'operations':[update('只想吃饭',required_experiences=['food'],visit_mode='focused')]}])
    data=client.post('/api/v1/chat',json={'text':'只想吃饭','current_preferences':pref}).json()['data']
    assert data['status']=='proposal'
    saved=client.post('/api/v1/routes',json=data['route_options'][0]['preferences']).json()['data']
    assert saved['preferences']['required_experiences']==['food']
    assert len(saved['stops'])==1 and saved['stops'][0]['place_id']=='meal'
    bad={**pref,'required_experiences':['food'],'budget_per_person_fen':100}
    response=client.post('/api/v1/route-options',json=bad)
    assert response.status_code==422
    assert response.json()['error']['details']['conflicts']['budget_limit']==1
    assert '预算不足' in response.json()['error']['message']


def active(client,pref):
    saved=client.post('/api/v1/routes',json=pref).json()['data']
    return client.post('/api/v1/routes/'+saved['route_id']+'/start',json={'base_revision':saved['revision']}).json()['data']


def complete(client,route):
    return client.post('/api/v1/routes/'+route['route_id']+'/progress',json={
        'base_revision':route['revision'],'completed_place_ids':[s['place_id'] for s in route['stops']],
        'effective_at':route['stops'][-1]['departure_at'],'source':'demo'}).json()['data']


def test_all_completed_returns_confirmable_completed_proposal_without_extra_visits(api):
    client,pref,app=api
    route=active(client,{**pref,'required_experiences':['food'],'visit_mode':'focused'})
    route=complete(client,route)
    url='/api/v1/routes/'+route['route_id']
    response=client.post(url+'/replan',json={'base_revision':route['revision'],
        'effective_at':route['progress']['effective_at'],'origin':'last_completed'})
    assert response.status_code==200,response.text
    proposal=response.json()['data']['proposals'][0]
    assert proposal['route']['status']=='completed'
    assert proposal['render']['remaining_place_ids']==[]
    assert proposal['route']['remaining_totals']['duration_s']==0
    assert client.get(url).json()['data']['status']=='active'
    accepted=client.post(url+'/accept',json={'base_revision':route['revision'],'proposal_id':proposal['proposal_id']})
    assert accepted.status_code==200
    assert accepted.json()['data']['status']=='completed'
    assert accepted.json()['data']['stops']==route['stops']


def test_completed_goal_is_not_scheduled_again_on_replan(api):
    client,pref,app=api
    route=active(client,{**pref,'required_experiences':['coffee'],'visit_mode':'focused'})
    route=complete(client,route)
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':route['progress']['effective_at'],'origin':'last_completed',
        'preference_patch':{'visit_mode':'focused','must_visit_ids':['temple']}})
    assert response.status_code==200,response.text
    plan=response.json()['data']['proposals'][0]['route']
    assert [s['place_id'] for s in plan['stops']]==['coffee','temple']
    assert plan['preferences']['required_experiences']==['coffee']


def test_last_minutes_can_offer_return_only_without_adding_stops(api):
    client,pref,app=api
    route=active(client,{**pref,'end_place_id':'start'})
    first=route['stops'][0]
    when=(datetime.fromisoformat(route['departure_at'])+timedelta(seconds=pref['max_duration_s']-800)).isoformat()
    progressed=client.post('/api/v1/routes/'+route['route_id']+'/progress',json={
        'base_revision':route['revision'],'completed_place_ids':[first['place_id']],'effective_at':when}).json()['data']
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':progressed['revision'],'effective_at':when,'origin':'last_completed'})
    assert response.status_code==200,response.text
    proposal=response.json()['data']['proposals'][0]
    assert proposal['route']['planning_outcome']=='return_only'
    assert proposal['render']['remaining_place_ids']==[]
    assert proposal['render']['legs'][-1]['to_place_id']=='start'
    assert proposal['route']['totals']['duration_s']<=pref['max_duration_s']


def test_remaining_unfulfilled_goal_cannot_be_replaced_by_finish_button(api,sample):
    from test_dynamic import position_for
    client,pref,app=api
    assert client.put('/api/v1/position',json=position_for(sample[0][0])).status_code==200
    route=active(client,{**pref,'required_experiences':['food']})
    when=(datetime.fromisoformat(route['departure_at'])+timedelta(seconds=pref['max_duration_s']-60)).isoformat()
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':when,'origin':'current_position'})
    assert response.status_code==422
    assert response.json()['error']['code']=='NO_FEASIBLE_ROUTE'
    assert client.get('/api/v1/routes/'+route['route_id']).json()['data']['revision']==route['revision']


def test_large_catalog_recall_keeps_required_experience_and_limits_graph(api,sample):
    client,pref,app=api
    places,stops,graph,_=sample
    extra=[]
    for i in range(24):
        p=places[0].model_copy(update={'place_id':'extra_'+str(i),'uid':'extra_'+str(i),'category':'culture'})
        extra.append(p)
        app.state.tools.stops.append(stops[2].model_copy(update={'place_id':p.place_id,'stop_id':'s_'+p.place_id}))
    app.state.database.seed_places(extra)
    original=app.state.segments.graph
    captured=[]
    async def counted(points):
        captured.extend(p.place_id for p in points)
        return await original(points)
    app.state.segments.graph=counted
    response=client.post('/api/v1/route-options',json={**pref,'required_experiences':['food']})
    assert response.status_code==200,response.text
    assert 'meal' in captured and len(captured)<=9
    assert all('meal' in [s['place_id'] for s in p['stops']] for p in response.json()['data']['options'])


def test_cold_graph_has_call_budget_and_preserves_cached_legs(tmp_path,sample):
    places,stops,graph,pref=sample
    database=Database(tmp_path/'map.sqlite3')
    cached_pair=(places[0],places[1])
    database.save_segment(SegmentRepository.cache_key(*cached_pair),graph[('start','coffee')])
    provider=type('Provider',(),{})()
    async def walking(a,b): return graph[(a.place_id,b.place_id)]
    provider.walking=AsyncMock(side_effect=walking)
    repository=SegmentRepository(database,provider,'baidu')
    result,failures=asyncio.run(repository.graph(places,max_live_queries=2))
    assert provider.walking.call_count==2
    assert ('start','coffee') in result
    assert any(f['code']=='ROUTE_QUERY_BUDGET' for f in failures)


def test_missing_position_rejected_before_any_road_query(api):
    client,pref,app=api
    app.state.segments.graph=AsyncMock(side_effect=AssertionError('should not query roads'))
    response=client.post('/api/v1/route-options',json={**pref,'use_current_position':True})
    assert response.status_code==422
    assert response.json()['error']['code']=='POSITION_REQUIRED'
    app.state.segments.graph.assert_not_called()
