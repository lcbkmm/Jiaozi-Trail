import asyncio
from datetime import datetime
from unittest.mock import AsyncMock
import pytest
from app.schemas import Preferences,VisitGoal
from app.storage.database import Database
from app.maps.segments import SegmentRepository
from test_demo_readiness import active,complete
from test_dynamic import position_for


def test_directory_replace_removes_old_merchants_without_changing_append_behavior(tmp_path,sample):
    places,*_=sample
    database=Database(tmp_path/'catalog.sqlite3')
    database.seed_places(places[:2]);assert len(database.places())==2
    database.seed_places(places[2:]);assert len(database.places())==4
    database.seed_places(places[:1],replace_all=True)
    assert [p.place_id for p in database.places()]==['start']


def test_catalog_change_invalidates_unaccepted_proposal(api,sample):
    client,pref,app=api
    assert client.put('/api/v1/position',json=position_for(sample[0][0])).status_code==200
    route=active(client,pref)
    url='/api/v1/routes/'+route['route_id']
    proposal=client.post(url+'/replan',json={'base_revision':route['revision'],'effective_at':route['departure_at'],
        'origin':'current_position'}).json()['data']['proposals'][0]
    changed=sample[0][2].model_copy(update={'longitude':104.088})
    app.state.database.seed_places([changed])
    response=client.post(url+'/accept',json={'base_revision':route['revision'],'proposal_id':proposal['proposal_id']})
    assert response.status_code==409,response.text
    assert response.json()['error']['code']=='STALE_PROPOSAL'
    assert client.get(url).json()['data']['revision']==route['revision']


def test_duplicate_accept_returns_current_version_instead_of_old_history(api):
    client,pref,app=api
    route=active(client,pref)
    route=complete(client,{**route,'stops':route['stops'][:1]})
    url='/api/v1/routes/'+route['route_id']
    proposal=client.post(url+'/replan',json={'base_revision':route['revision'],'effective_at':route['progress']['effective_at'],
        'origin':'last_completed'}).json()['data']['proposals'][0]
    accept_body={'base_revision':route['revision'],'proposal_id':proposal['proposal_id']}
    accepted=client.post(url+'/accept',json=accept_body).json()['data']
    next_stop=accepted['stops'][1]
    progressed=client.post(url+'/progress',json={'base_revision':accepted['revision'],
        'completed_place_ids':[s['place_id'] for s in accepted['stops'][:2]],'effective_at':next_stop['departure_at']}).json()['data']
    repeated=client.post(url+'/accept',json=accept_body).json()['data']
    assert repeated['revision']==progressed['revision']
    assert repeated['progress']==progressed['progress']


def test_single_stop_plan_does_not_query_candidate_to_candidate_roads(api):
    client,pref,app=api
    original=app.state.segments.graph
    observed=[]
    async def capture(points,**kwargs):
        observed.extend(kwargs.get('edges',[]))
        return await original(points,**kwargs)
    app.state.segments.graph=capture
    response=client.post('/api/v1/route-options',json={**pref,'required_goals':[{'any_of':['coffee','food']}],'visit_mode':'focused'})
    assert response.status_code==200,response.text
    assert observed and all(a=='start' for a,b in observed)


def test_cancelled_precise_position_request_releases_lock(tmp_path,sample):
    places,stops,graph,pref=sample
    database=Database(tmp_path/'cancel.sqlite3')
    entered=asyncio.Event();wait=asyncio.Event()
    async def walking(a,b):
        entered.set();await wait.wait();return graph['start','coffee']
    provider=type('Provider',(),{})();provider.walking=walking
    repository=SegmentRepository(database,provider,'baidu')
    async def run():
        task=asyncio.create_task(repository.get_from_position(places[0],places[1]))
        await entered.wait();task.cancel()
        with pytest.raises(asyncio.CancelledError):await task
        assert repository.locks=={}
    asyncio.run(run())


def test_initial_plan_does_not_return_a_mixed_state_snapshot(api):
    from app.dynamic.schemas import StateEvent
    client,pref,app=api
    original=app.state.segments.graph
    token=client.headers['X-Demo-Session']
    async def changed(points,**kwargs):
        result=await original(points,**kwargs)
        app.state.dynamic_repository.update_state(token,StateEvent(place_id='coffee',base_state_version=1,queue_s=3600))
        return result
    app.state.segments.graph=changed
    response=client.post('/api/v1/route-options',json=pref)
    assert response.status_code==409,response.text
    assert response.json()['error']['code']=='STALE_PROPOSAL'
