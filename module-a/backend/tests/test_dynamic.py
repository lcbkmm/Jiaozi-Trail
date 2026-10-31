from datetime import datetime, timedelta, timezone
import pytest


def active_route(client,pref):
    route=client.post('/api/v1/routes',json=pref).json()['data']
    return client.post('/api/v1/routes/'+route['route_id']+'/start',json={'base_revision':1}).json()['data']


def position_for(place,**extra):
    return {'longitude':place.longitude,'latitude':place.latitude,'coord_system':'gcj02',
            'accuracy_m':10,'observed_at':datetime.now(timezone.utc).isoformat(),
            'source':'device',**extra}


def test_location_validation_and_current_position_route(api,sample):
    client,pref,app=api;places,*_=sample
    old=position_for(places[0],observed_at=(datetime.now(timezone.utc)-timedelta(minutes=5)).isoformat())
    assert client.put('/api/v1/position',json=old).json()['error']['code']=='STALE_POSITION'
    assert client.put('/api/v1/position',json=position_for(places[0],accuracy_m=300)).status_code==422
    assert client.put('/api/v1/position',json=position_for(places[0],coord_system='bd09')).status_code==422
    assert client.put('/api/v1/position',json=position_for(places[0],longitude=110)).json()['error']['code']=='OUTSIDE_SERVICE_AREA'
    assert client.put('/api/v1/position',json=position_for(places[0])).status_code==200
    pref['use_current_position']=True
    response=client.post('/api/v1/route-options',json=pref)
    assert response.status_code==200,response.text
    assert response.json()['data']['origin']['reused_place_id']=='start'
    assert app.state.maps.calls==0


def test_session_state_isolation_close_queue_and_inventory(api):
    client,pref,app=api
    change=client.post('/api/v1/demo/events',json={'place_id':'coffee','base_state_version':1,'status':'closed','queue_s':3600,'inventory_status':'sold_out'})
    assert change.status_code==200
    assert client.post('/api/v1/demo/events',json={'place_id':'coffee','base_state_version':1,'queue_s':0}).status_code==409
    detail=client.get('/api/v1/places/coffee').json()['data']
    assert detail['opening_status']['value']=='closed' and detail['queue']['duration_s']==3600
    route=client.post('/api/v1/routes',json=pref).json()['data']
    assert route['state_version']==2
    assert 'coffee' not in [s['place_id'] for s in route['stops']]
    other=client.post('/api/v1/demo/sessions',json={}).json()['data']['session_token']
    assert client.get('/api/v1/places/coffee',headers={'X-Demo-Session':other}).json()['data']['opening_status']['value']=='open'


def test_progress_and_replan_preserve_prefix_remaining_time_cost_and_limit(api):
    client,pref,app=api
    route=active_route(client,pref)
    first=route['stops'][0]
    when=first['departure_at']
    response=client.post('/api/v1/routes/'+route['route_id']+'/progress',json={
        'base_revision':route['revision'],'completed_place_ids':[first['place_id']],
        'effective_at':when,'spent_per_person_fen':first['cost_max_per_person_fen'],'actual_walk_m':100})
    assert response.status_code==200,response.text
    progressed=response.json()['data']
    progress_revision=progressed['revision']
    proposal_response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':progress_revision,'effective_at':when,'origin':'last_completed','reason':'用户想少走一点',
        'preference_patch':{'planning_style':'less_walking'}})
    assert proposal_response.status_code==200,proposal_response.text
    data=proposal_response.json()['data'];proposal=data['proposals'][0]
    assert data['route_modified'] is False
    assert client.get('/api/v1/routes/'+route['route_id']).json()['data']['revision']==progress_revision
    planned=proposal['route']
    assert planned['stops'][0]==first
    assert planned['progress']==progressed['progress']
    assert len(planned['stops'])<=5
    assert first['place_id'] not in proposal['render']['remaining_place_ids']
    assert planned['totals']['duration_s']<=pref['max_duration_s']
    assert planned['totals']['cost_max_per_person_fen']<=pref['budget_per_person_fen']
    assert sum(s['category']=='meal' for s in planned['stops'])<=1
    assert sum(s['category'] in {'coffee','tea'} for s in planned['stops'])<=1
    accepted=client.post('/api/v1/routes/'+route['route_id']+'/accept',json={
        'base_revision':progress_revision,'proposal_id':proposal['proposal_id']})
    assert accepted.status_code==200,accepted.text
    assert accepted.json()['data']['revision']==progress_revision+1
    again=client.post('/api/v1/routes/'+route['route_id']+'/accept',json={
        'base_revision':progress_revision,'proposal_id':proposal['proposal_id']})
    assert again.status_code==200 and again.json()['data']['revision']==progress_revision+1


@pytest.mark.parametrize('change',['state','position','progress'])
def test_proposal_rejects_changes_during_user_confirmation(api,sample,change):
    client,pref,app=api;places,*_=sample
    route=active_route(client,pref)
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':route['departure_at'],'origin':'current_position'})
    assert response.status_code==422
    client.put('/api/v1/position',json=position_for(places[0]))
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':route['departure_at'],'origin':'current_position'})
    assert response.status_code==200,response.text
    proposal=response.json()['data']['proposals'][0]
    if change=='state':client.post('/api/v1/demo/events',json={'place_id':'coffee','base_state_version':1,'queue_s':500})
    if change=='position':client.put('/api/v1/position',json=position_for(places[1]))
    if change=='progress':
        first=route['stops'][0]
        client.post('/api/v1/routes/'+route['route_id']+'/progress',json={'base_revision':route['revision'],
             'completed_place_ids':[first['place_id']],'effective_at':first['departure_at']})
    result=client.post('/api/v1/routes/'+route['route_id']+'/accept',json={
        'base_revision':route['revision'],'proposal_id':proposal['proposal_id']})
    assert result.status_code==409,result.text


def test_required_closed_place_returns_conflict_instead_of_removal(api):
    client,pref,app=api
    pref['must_visit_ids']=['coffee']
    route=active_route(client,pref)
    client.post('/api/v1/demo/events',json={'place_id':'coffee','base_state_version':1,'status':'closed'})
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':route['departure_at'],'origin':'planned_start'})
    assert response.status_code==422
    # Active users cannot silently be returned to the initial start.
    assert response.json()['error']['code']=='POSITION_REQUIRED'
    route=client.get('/api/v1/routes/'+route['route_id']).json()['data']
    assert route['preferences']['must_visit_ids']==['coffee']


def test_progress_is_idempotent_cannot_reorder_and_has_no_reward(api):
    client,pref,app=api
    route=active_route(client,pref)
    url='/api/v1/routes/'+route['route_id']+'/progress'
    body={'base_revision':route['revision'],'completed_place_ids':[route['stops'][0]['place_id']],
          'effective_at':route['stops'][0]['departure_at']}
    first=client.post(url,json=body);second=client.post(url,json=body)
    assert first.status_code==200 and second.status_code==200
    assert first.json()['data']['revision']==second.json()['data']['revision']
    bad={**body,'base_revision':first.json()['data']['revision'],'completed_place_ids':[]}
    assert client.post(url,json=bad).status_code==422
    assert 'reward' not in first.json()['data']['progress']


def test_required_closed_place_remains_hard_constraint_with_valid_origin(api,sample):
    client,pref,app=api;places,*_=sample
    pref['must_visit_ids']=['coffee']
    route=active_route(client,pref)
    client.put('/api/v1/position',json=position_for(places[0]))
    client.post('/api/v1/demo/events',json={'place_id':'coffee','base_state_version':1,'status':'closed'})
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':route['departure_at'],'origin':'current_position'})
    assert response.status_code==422 and response.json()['error']['code']=='NO_FEASIBLE_ROUTE'


def test_arbitrary_position_uses_exact_coordinate_without_shared_cache(api,sample):
    from app.schemas import WalkingLeg,Point
    client,pref,app=api;places,*_=sample
    calls=[]
    async def walking(origin,target):
        calls.append((origin,target))
        return WalkingLeg(from_place_id=origin.place_id,to_place_id=target.place_id,
            distance_m=120,duration_s=120,points=[Point(longitude=origin.longitude,latitude=origin.latitude),
            Point(longitude=target.longitude,latitude=target.latitude)],retrieved_at=datetime.now(timezone.utc),entrance_version='1:1')
    app.state.maps.walking=walking
    app.state.segments.mode='baidu'
    before=app.state.database.segment_count()
    supplied=position_for(places[0],longitude=places[0].longitude+.0001)
    assert client.put('/api/v1/position',json=supplied).status_code==200
    pref['use_current_position']=True
    result=client.post('/api/v1/route-options',json=pref)
    assert result.status_code==200,result.text
    data=result.json()['data']
    assert data['origin']['longitude']==supplied['longitude']
    assert all(option['legs'][0]['points'][0]['longitude']==supplied['longitude'] for option in data['options'])
    assert calls and all(origin.place_id=='user_position' for origin,target in calls)
    assert app.state.database.segment_count()==before
    assert all(p.place_id!='user_position' for p in app.state.database.places())


def test_progress_after_replan_uses_full_leg_history_and_conservative_spend(api):
    client,pref,app=api;route=active_route(client,pref)
    first=route['stops'][0]
    progressed=client.post('/api/v1/routes/'+route['route_id']+'/progress',json={
        'base_revision':route['revision'],'completed_place_ids':[first['place_id']],
        'effective_at':first['departure_at']}).json()['data']
    proposals=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':progressed['revision'],'effective_at':first['departure_at'],'origin':'last_completed'}).json()['data']['proposals']
    proposal=proposals[0]
    accepted=client.post('/api/v1/routes/'+route['route_id']+'/accept',json={
        'base_revision':progressed['revision'],'proposal_id':proposal['proposal_id']}).json()['data']
    assert accepted['totals']['duration_s']==sum(accepted['totals'][key] for key in
        ('walk_duration_s','wait_duration_s','queue_duration_s','dwell_duration_s','buffer_s','elapsed_adjustment_s'))
    if len(accepted['stops'])>1:
        second=accepted['stops'][1]
        response=client.post('/api/v1/routes/'+route['route_id']+'/progress',json={
            'base_revision':accepted['revision'],'completed_place_ids':[first['place_id'],second['place_id']],
            'effective_at':second['departure_at']})
        assert response.status_code==200,response.text
        data=response.json()['data']
        assert data['progress']['spent_per_person_fen']>=first['cost_max_per_person_fen']+second['cost_max_per_person_fen']
        assert data['progress']['walked_m']==sum(leg['distance_m'] for leg in accepted['history_legs'][:2])


def test_expired_and_wrong_session_proposal_cannot_be_accepted(api):
    client,pref,app=api
    route=client.post('/api/v1/routes',json=pref).json()['data']
    proposal=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':route['departure_at'],'origin':'planned_start'}).json()['data']['proposals'][0]
    other=client.post('/api/v1/demo/sessions',json={}).json()['data']['session_token']
    body={'base_revision':route['revision'],'proposal_id':proposal['proposal_id']}
    assert client.post('/api/v1/routes/'+route['route_id']+'/accept',json=body,headers={'X-Demo-Session':other}).status_code==404
    with app.state.database.connection() as db:
        db.execute('UPDATE route_proposals SET expires_at=? WHERE proposal_id=?',
                   ((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(),proposal['proposal_id']))
    assert client.post('/api/v1/routes/'+route['route_id']+'/accept',json=body).status_code==409


def test_state_changes_produce_risk_reasons_without_modifying_route(api):
    client,pref,app=api
    route=active_route(client,pref)
    assert client.get('/api/v1/routes/'+route['route_id']+'/assessment').json()['data']['replan_suggested'] is False
    place=route['stops'][-1]['place_id']
    client.post('/api/v1/demo/events',json={'place_id':place,'base_state_version':1,'status':'closed','queue_s':3600,'inventory_status':'sold_out'})
    assessment=client.get('/api/v1/routes/'+route['route_id']+'/assessment').json()['data']
    assert assessment['replan_suggested'] and assessment['route_modified'] is False
    assert {'closed','queue_limit'}<={r['type'] for r in assessment['reasons']}
    assert assessment['warnings'][0]['type']=='benefit_sold_out'
    assert client.get('/api/v1/routes/'+route['route_id']).json()['data']['revision']==route['revision']
