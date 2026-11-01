import asyncio
import json
from datetime import datetime,timezone
import httpx
import pytest
from app.errors import AppError
from app.schemas import VisitGoal,Place,CampaignStop,Preferences
from app.planner.search import search_routes
from app.catalog import CatalogIndex
from app.maps.segments import SegmentRepository
from app.storage.database import Database
from app.intent.gateway import ModelGateway
from app.config import Settings
from test_intent import install_parser,update
from test_demo_readiness import active,complete
from test_dynamic import position_for


def test_or_goals_are_alternatives_not_two_required_visits(sample):
    places,stops,graph,pref=sample
    pref=pref.model_copy(update={'required_goals':[VisitGoal(any_of=['coffee','food'])],'visit_mode':'focused'})
    result=search_routes(pref,places,stops,graph,include_options=True)
    assert all(len(o['stops'])==1 and o['stops'][0]['place_id'] in {'coffee','meal'} for o in result['options'])


def test_sequence_must_hold_for_all_options_and_save(sample):
    places,stops,graph,pref=sample
    sequence=[VisitGoal(place_ids=['temple']),VisitGoal(any_of=['food'])]
    pref=pref.model_copy(update={'visit_sequence':sequence,'visit_mode':'focused'})
    result=search_routes(pref,places,stops,graph,include_options=True)
    assert all([s['place_id'] for s in o['stops']]==['temple','meal'] for o in result['options'])
    impossible=pref.model_copy(update={'excluded_place_ids':['temple']})
    with pytest.raises(AppError):search_routes(impossible,places,stops,graph)


def test_new_experience_tag_needs_only_catalog_data(api):
    client,pref,app=api
    stop=app.state.tools.stops[1].model_copy(update={'interests':['food','chuan_chuan'],'experience_labels':{'chuan_chuan':'串串'}})
    app.state.tools.stops=[stop if s.place_id==stop.place_id else s for s in app.state.tools.stops]
    fake=install_parser(app,[{'operations':[update('我想吃串串',required_experiences=['chuan_chuan'],visit_mode='focused')]}])
    response=client.post('/api/v1/chat',json={'text':'我想吃串串','current_preferences':pref})
    assert response.status_code==200,response.text
    data=response.json()['data']
    assert data['status']=='proposal' and data['route_options'][0]['stops'][0]['place_id']=='meal'
    assert fake.seen[0][5]['chuan_chuan']=='串串'


def test_unknown_catalog_tag_is_rejected_before_map_and_chat_clarifies(api):
    client,pref,app=api
    payload={**pref,'required_experiences':['nonexistent_experience']}
    response=client.post('/api/v1/route-options',json=payload)
    assert response.status_code==422 and response.json()['error']['code']=='UNSUPPORTED_EXPERIENCE'
    install_parser(app,[{'operations':[update('新体验',required_experiences=['nonexistent_experience'])]}])
    data=client.post('/api/v1/chat',json={'text':'新体验','current_preferences':pref}).json()['data']
    assert data['status']=='clarify' and not data['tool_trace']


def test_model_context_is_bounded_with_large_catalog_and_selected_place_kept(api,sample):
    client,pref,app=api
    places,stops,*_=sample
    new_places=[]
    for i in range(1500):
        pid='shop_'+str(i)
        new_places.append(places[0].model_copy(update={'place_id':pid,'name':'测试商家'+str(i),'uid':pid}))
        app.state.tools.stops.append(stops[2].model_copy(update={'place_id':pid,'stop_id':'stop_'+pid}))
    app.state.database.seed_places(new_places)
    fake=install_parser(app,[{'operations':[{'type':'get_place_details','place_query':'这家','evidence':'这家排多久'}]}])
    data=client.post('/api/v1/chat',json={'text':'这家排多久','current_preferences':pref,'selected_place_id':'shop_1499'}).json()['data']
    assert data['status']=='answered'
    assert len(fake.seen[0][2])<=24
    assert any(row['place_id']=='shop_1499' for row in fake.seen[0][2])
    assert len(fake.seen[0][5])<=128
    index=app.state.tools.catalog()
    app.state.database.places=lambda: (_ for _ in ()).throw(AssertionError('catalog reloaded'))
    assert app.state.tools.catalog() is index
    assert app.state.tools.place_details('shop_1499')['place']['place_id']=='shop_1499'


def test_brand_alias_does_not_silently_choose_a_branch(sample):
    places,stops,*_=sample
    a=places[1].model_copy(update={'place_id':'branch_a','name':'新品牌甲店','aliases':['新品牌']})
    b=places[1].model_copy(update={'place_id':'branch_b','name':'新品牌乙店','aliases':['新品牌']})
    index=CatalogIndex([a,b],[])
    assert len(index.resolve('新品牌'))==2
    assert index.resolve('新品牌甲店')[0].place_id=='branch_a'


def test_explicit_multiple_drinks_are_configurable_not_hardcoded(sample):
    places,stops,graph,pref=sample
    stops[1]=stops[1].model_copy(update={'category':'tea','interests':['tea']})
    pref=pref.model_copy(update={'visit_sequence':[VisitGoal(any_of=['coffee']),VisitGoal(any_of=['tea'])],
                                 'category_limits':{'drink':2,'meal':1},'visit_mode':'focused'})
    route=search_routes(pref,places,stops,graph)
    assert [s['place_id'] for s in route['stops']]==['coffee','meal']


def test_nearby_tool_filters_experience_not_just_category(api):
    client,pref,app=api
    body={'name':'search_nearby_places','arguments':{'longitude':104.08,'latitude':30.65,'radius_m':1000,'interest':'coffee'}}
    response=client.post('/api/v1/tools/call',json=body)
    assert response.status_code==200,response.text
    assert [p['place_id'] for p in response.json()['data']]==['coffee']


def test_sequence_progress_survives_replan_and_cannot_be_reversed(api):
    client,pref,app=api
    route=active(client,{**pref,'required_experiences':['culture'],'visit_mode':'focused'})
    route=complete(client,route)
    url='/api/v1/routes/'+route['route_id']
    response=client.post(url+'/replan',json={'base_revision':route['revision'],'effective_at':route['progress']['effective_at'],
        'origin':'last_completed','preference_patch':{'visit_sequence':[{'place_ids':['temple']},{'any_of':['food']}]}})
    assert response.status_code==200,response.text
    proposal=response.json()['data']['proposals'][0]
    assert [s['place_id'] for s in proposal['route']['stops']]==['temple','meal']
    bad=client.post(url+'/replan',json={'base_revision':route['revision'],'effective_at':route['progress']['effective_at'],
        'origin':'last_completed','preference_patch':{'visit_sequence':[{'any_of':['food']},{'place_ids':['temple']}]}})
    assert bad.status_code==422


def test_precise_position_route_cache_deduplicates_and_never_enters_database(tmp_path,sample):
    places,stops,graph,pref=sample
    from unittest.mock import AsyncMock
    database=Database(tmp_path/'cache.sqlite3')
    provider=type('Provider',(),{})()
    provider.walking=AsyncMock(return_value=graph[('start','coffee')])
    repository=SegmentRepository(database,provider,'baidu')
    async def run():
        results=await asyncio.gather(*(repository.get_from_position(places[0],places[1]) for _ in range(5)))
        assert len(results)==5
        assert provider.walking.call_count==1
        assert database.segment_count()==0
        assert repository.locks=={}
    asyncio.run(run())


def test_completed_route_cannot_be_restarted_or_replanned(api):
    client,pref,app=api
    route=complete(client,active(client,{**pref,'required_experiences':['food'],'visit_mode':'focused'}))
    url='/api/v1/routes/'+route['route_id']
    proposal=client.post(url+'/replan',json={'base_revision':route['revision'],'effective_at':route['progress']['effective_at'],'origin':'last_completed'}).json()['data']['proposals'][0]
    accepted=client.post(url+'/accept',json={'base_revision':route['revision'],'proposal_id':proposal['proposal_id']}).json()['data']
    assert accepted['status']=='completed'
    assert client.post(url+'/start',json={'base_revision':accepted['revision']}).status_code==409
    assert client.post(url+'/replan',json={'base_revision':accepted['revision'],'effective_at':route['progress']['effective_at'],'origin':'last_completed'}).status_code==409


def test_parse_history_is_bounded_and_schema_is_compact():
    payloads=[]
    def handler(request):
        payloads.append(json.loads(request.content))
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({'operations':[],'clarification':'测试'})}}]})
    gateway=ModelGateway(Settings(llm_api_key='test-only'),httpx.Client(base_url='https://test.invalid/',transport=httpx.MockTransport(handler)))
    try:
        gateway.parse('测试',{},[],[{'role':'user','text':'a'*2000} for _ in range(100)],None)
        context=json.loads(payloads[0]['messages'][1]['content'])
        assert len(context['history'])==8
        assert all(len(row['text'])<=600 for row in context['history'])
        assert 'title' not in context['schema']
    finally:gateway.close()
