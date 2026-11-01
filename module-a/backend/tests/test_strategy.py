from app.schemas import Preferences
from app.planner.search import search_routes
from test_demo_readiness import active
from test_dynamic import position_for


def test_requested_strategy_is_recommended_and_preserved_when_options_deduplicate(sample):
    places,stops,graph,pref=sample
    pref=pref.model_copy(update={'planning_style':'less_walking'})
    result=search_routes(pref,places,stops,graph,include_options=True)
    assert result['recommended_id']=='less_walking'
    assert result['options'][0]['recommended']
    assert result['options'][0]['option_id']=='less_walking'
    assert result['options'][0]['preferences']['planning_style']=='less_walking'
    assert result['options'][0]['totals']['walk_distance_m']<=min(o['totals']['walk_distance_m'] for o in result['options'])
    for option in result['options']:
        saved=search_routes(Preferences.model_validate(option['preferences']),places,stops,graph)
        assert saved['stop_ids']==option['stop_ids']


def test_progress_does_not_overflow_public_exclusion_limit(api,sample):
    client,pref,app=api
    places,*_=sample
    extra=[places[0].model_copy(update={'place_id':'excluded_'+str(i),'uid':'excluded_'+str(i)}) for i in range(20)]
    app.state.database.seed_places(extra)
    route=active(client,{**pref,'excluded_place_ids':[p.place_id for p in extra]})
    first=route['stops'][0]
    url='/api/v1/routes/'+route['route_id']
    route=client.post(url+'/progress',json={'base_revision':route['revision'],
        'completed_place_ids':[first['place_id']],'effective_at':first['departure_at']}).json()['data']
    response=client.post(url+'/replan',json={'base_revision':route['revision'],'effective_at':first['departure_at'],'origin':'last_completed'})
    assert response.status_code==200,response.text
    assert all(first['place_id'] not in p['render']['remaining_place_ids'] for p in response.json()['data']['proposals'])


def test_replan_alternative_strategy_is_preserved_in_the_proposal(api,sample):
    client,pref,app=api
    client.put('/api/v1/position',json=position_for(sample[0][0]))
    route=active(client,pref)
    response=client.post('/api/v1/routes/'+route['route_id']+'/replan',json={
        'base_revision':route['revision'],'effective_at':route['departure_at'],'origin':'current_position'})
    assert response.status_code==200,response.text
    for proposal in response.json()['data']['proposals']:
        assert proposal['route']['preferences']['planning_style']==proposal['option_id']
