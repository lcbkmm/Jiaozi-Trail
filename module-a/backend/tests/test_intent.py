from dataclasses import replace
import asyncio
import json
import math
import httpx
import pytest
from pydantic import ValidationError
from llm2jev import Choice, JevRequest, LLM2Jev
from app.config import Settings
from app.errors import AppError
from app.intent.gateway import ModelGateway
from app.intent.binary_backend import JevAdvisor, RemoteBinaryBackend, yes_probability
from app.intent.schemas import ParsedTurn, PreferencePatch


class FakeParser:
    def __init__(self, turns):self.turns=list(turns);self.seen=[];self.settings=Settings(llm_model="test-only",jev_enabled=False)
    def parse(self,*args):
        self.seen.append(args)
        value=self.turns.pop(0)
        if isinstance(value,Exception):raise value
        return ParsedTurn.model_validate(value)


def install_parser(app,turns):
    fake=FakeParser(turns)
    app.state.intent.gateway=fake
    app.state.intent.advisor=JevAdvisor(fake)
    return fake


def update(text,**patch):return {"type":"update_preferences","evidence":text,"patch":patch}


def test_multi_operation_preserves_constraints_and_does_not_mutate_routes(api):
    client,pref,app=api
    created=client.post("/api/v1/routes",json=pref).json()["data"]
    fake=install_parser(app,[{"operations":[update("预算改为90元",budget_per_person_fen=9000),
         {"type":"require_place","evidence":"保留coffee","place_query":"coffee"}]}])
    response=client.post("/api/v1/chat",json={"text":"预算改为90元，保留coffee","current_preferences":pref})
    assert response.status_code==200,response.text
    data=response.json()["data"]
    assert data["status"]=="proposal" and data["needs_confirmation"]
    assert data["preferences"]["budget_per_person_fen"]==9000
    assert data["preferences"]["max_walk_m"]==pref["max_walk_m"]
    assert "coffee" in data["preferences"]["must_visit_ids"]
    assert data["tool_trace"]==[{"name":"plan_route_options","status":"success"}]
    assert data["route_modified"] is False
    assert client.get("/api/v1/routes/"+created["route_id"]).json()["data"]["revision"]==1
    assert len(client.get("/api/v1/routes").json()["data"])==1


def test_negation_filters_forbidden_interest_from_all_options(api):
    client,pref,app=api
    install_parser(app,[{"operations":[update("不要美食",excluded_interests=["food"])]}])
    result=client.post("/api/v1/chat",json={"text":"不要美食","current_preferences":pref}).json()["data"]
    assert result["status"]=="proposal"
    assert all(s["place_id"]!="meal" for option in result["route_options"] for s in option["stops"])


def test_unknown_place_and_unbound_pronoun_request_clarification(api):
    client,pref,app=api
    install_parser(app,[{"operations":[{"type":"get_place_details","evidence":"这家排多久","place_query":"这家"}]},
                        {"operations":[{"type":"insert_place","evidence":"去不存在的店","place_query":"不存在的店"}]}])
    first=client.post("/api/v1/chat",json={"text":"这家排多久","current_preferences":pref}).json()["data"]
    assert first["status"]=="clarify" and not first["tool_trace"]
    second=client.post("/api/v1/chat",json={"text":"去不存在的店","context_revision":first["context_revision"]}).json()["data"]
    assert second["status"]=="clarify" and "没有找到" in second["reply"]


def test_selected_place_is_grounded_and_crowd_is_unknown(api):
    client,pref,app=api
    install_parser(app,[{"operations":[{"type":"get_place_details","evidence":"这家人多吗","place_query":"这家"}]}])
    data=client.post("/api/v1/chat",json={"text":"这家人多吗","current_preferences":pref,"selected_place_id":"coffee"}).json()["data"]
    assert data["status"]=="answered"
    detail=data["tool_results"][0]["data"]
    assert detail["place"]["place_id"]=="coffee" and detail["crowd_density"]["value"] is None


def test_ambiguity_remains_confirmation_when_jev_is_disabled(api):
    client,pref,app=api
    install_parser(app,[{"operations":[],"clarification":"加入行程还是记在交子？","ambiguity_candidates":["add_memory","insert_place"]}])
    data=client.post("/api/v1/chat",json={"text":"把这家加上","current_preferences":pref,"selected_place_id":"coffee"}).json()["data"]
    assert data["status"]=="clarify" and data["decision"]["mode"]=="not_enabled"
    assert not data["tool_trace"]


def test_context_survives_and_cross_session_is_isolated(api):
    client,pref,app=api
    fake=install_parser(app,[{"operations":[update("预算90元",budget_per_person_fen=9000)]},
                            {"operations":[update("两小时",max_duration_s=7200)]}])
    first=client.post("/api/v1/chat",json={"text":"预算90元","current_preferences":pref}).json()["data"]
    second=client.post("/api/v1/chat",json={"text":"两小时","context_revision":first["context_revision"]}).json()["data"]
    assert second["preferences"]["budget_per_person_fen"]==9000
    assert fake.seen[1][3][-1]["role"]=="assistant"
    assert client.get("/api/v1/chat").json()["data"]["revision"]==2
    other=client.post("/api/v1/demo/sessions",json={}).json()["data"]["session_token"]
    assert client.get("/api/v1/chat",headers={"X-Demo-Session":other}).json()["data"]["history"]==[]
    stale=client.post("/api/v1/chat",json={"text":"继续","context_revision":0})
    assert stale.status_code==409 and len(fake.seen)==2


def test_clarify_and_no_solution_do_not_commit_partial_patch(api):
    client,pref,app=api
    install_parser(app,[{"operations":[update("预算50元",budget_per_person_fen=5000),
        {"type":"require_place","evidence":"必去meal","place_query":"meal"}]}])
    result=client.post("/api/v1/chat",json={"text":"预算50元，必去meal","current_preferences":pref}).json()["data"]
    assert result["status"]=="no_feasible_route"
    assert result["preferences"]["budget_per_person_fen"]==pref["budget_per_person_fen"]
    assert client.get("/api/v1/routes").json()["data"]==[]


def test_active_route_cannot_be_replanned_by_stage2a(api):
    client,pref,app=api
    route=client.post("/api/v1/routes",json=pref).json()["data"]
    active=client.post("/api/v1/routes/"+route["route_id"]+"/start",json={"base_revision":1}).json()["data"]
    install_parser(app,[{"operations":[update("预算改为90元",budget_per_person_fen=9000)]}])
    result=client.post("/api/v1/chat",json={"text":"预算改为90元","route_id":route["route_id"],"base_revision":active["revision"]}).json()["data"]
    assert result["status"]=="clarify" and not result["tool_trace"]
    assert client.get("/api/v1/routes/"+route["route_id"]).json()["data"]["revision"]==2


def test_required_place_cannot_be_removed_by_replacement(api):
    client,pref,app=api
    pref["must_visit_ids"]=["coffee"]
    install_parser(app,[{"operations":[{"type":"replace_place","evidence":"换成meal","place_query":"coffee","replacement_query":"meal"}]}])
    data=client.post("/api/v1/chat",json={"text":"换成meal","current_preferences":pref}).json()["data"]
    assert data["status"]=="clarify" and not data["tool_trace"]


def test_unimplemented_memory_has_no_write_or_reward_claim(api):
    client,pref,app=api
    install_parser(app,[{"operations":[{"type":"add_memory","evidence":"记在交子上","place_query":"这家"}]}])
    data=client.post("/api/v1/chat",json={"text":"记在交子上","current_preferences":pref,"selected_place_id":"coffee"}).json()["data"]
    assert data["status"]=="not_available" and "尚未保存" in data["reply"]


def test_model_failure_does_not_write_chat_or_routes(api):
    client,pref,app=api
    install_parser(app,[AppError("MODEL_UNAVAILABLE","模型不可用",503)])
    response=client.post("/api/v1/chat",json={"text":"安排路线","current_preferences":pref})
    assert response.status_code==503
    assert client.get("/api/v1/chat").json()["data"]["revision"]==0
    assert client.get("/api/v1/routes").json()["data"]==[]


def test_unsupported_dietary_constraint_is_not_silently_ignored(api):
    client,pref,app=api
    install_parser(app,[{"operations":[update("预算90元",budget_per_person_fen=9000)],"clarification":"当前无法核实花生过敏安全，请确认是否只保留非餐饮点。"}])
    data=client.post("/api/v1/chat",json={"text":"预算90元，花生过敏","current_preferences":pref}).json()["data"]
    assert data["status"]=="clarify" and data["preferences"]==pref and not data["tool_trace"]


def make_gateway(response,settings=None):
    client=httpx.Client(base_url="https://test.invalid/",transport=httpx.MockTransport(lambda req: response(req)))
    return ModelGateway(settings or Settings(llm_api_key="test-key",llm_model="test-only",llm_thinking_profile="off"),client=client)


def test_json_extraction_preserves_schema_and_requests_normal_length():
    def handler(request):
        payload=json.loads(request.content)
        assert payload["max_tokens"]>1 and payload["model"]=="test-only"
        assert payload["enable_thinking"] is False
        return httpx.Response(200,json={"choices":[{"finish_reason":"stop","message":{"content":json.dumps({"operations":[update("150元",budget_per_person_fen=15000)]})}}]})
    gateway=make_gateway(handler)
    try:
        parsed=gateway.parse("预算改成150元",{},[],[],None)
        assert parsed.operations[0].patch.budget_per_person_fen==15000
    finally:gateway.close()


@pytest.mark.parametrize("content",['{oops}',json.dumps({"operations":[update("虚构原文",budget_per_person_fen=15000)]}),json.dumps({"operations":[{"type":"execute_python","evidence":"预算"}]})])
def test_invalid_model_output_cannot_execute(content):
    gateway=make_gateway(lambda req:httpx.Response(200,json={"choices":[{"message":{"content":content}}]}))
    try:
        with pytest.raises(AppError) as caught:gateway.parse("预算",{},[],[],None)
        assert caught.value.code=="MODEL_INVALID_RESPONSE"
    finally:gateway.close()


def test_503_has_cooldown_and_no_fallback_or_secret():
    calls=[]
    def response(request):
        calls.append(json.loads(request.content)["model"])
        return httpx.Response(503,json={"error":{"message":"test-key private"}})
    gateway=make_gateway(response)
    try:
        for _ in range(2):
            with pytest.raises(AppError) as caught:gateway.complete({"messages":[]})
            assert "test-key" not in str(caught.value)
        assert calls==["test-only"]
    finally:gateway.close()


@pytest.mark.parametrize("rows",[[],[{"token":"yes","logprob":-0.1}], [{"token":"yes","logprob":float("nan")},{"token":"no","logprob":-2}]])
def test_binary_scores_require_complete_finite_candidates(rows):
    with pytest.raises(AppError):yes_probability({"choices":[{"logprobs":{"content":[{"top_logprobs":rows}]}}]})


def test_real_jev_library_consumes_exact_binary_backend():
    class FakeGateway:
        settings=Settings(llm_model="test-only",jev_enabled=True)
        def thinking(self):return {"enable_thinking":False}
        def complete(self,payload):
            assert payload["max_tokens"]==1 and payload["top_logprobs"]==5
            return {"choices":[{"logprobs":{"content":[{"top_logprobs":[{"token":" yes","logprob":math.log(.8)},{"token":" no","logprob":math.log(.2)}]}]}}]}
    data=JevAdvisor(FakeGateway()).advise("把这家加上","coffee",["add_memory","insert_place"])
    assert data["mode"]=="jev_logprobs" and data["requires_confirmation"]
    assert data["raw_support"]=={"add_memory":pytest.approx(.8),"insert_place":pytest.approx(.8)}
    assert data["relative_probabilities"]["add_memory"]==pytest.approx(.5)


def test_patch_rejects_unknown_tags_and_coerced_money():
    with pytest.raises(ValidationError):PreferencePatch(interests=["invented"])
    with pytest.raises(ValidationError):PreferencePatch(budget_per_person_fen="15000")


def test_deepseek_thinking_profile_disables_reasoning_explicitly():
    gateway=make_gateway(lambda req:httpx.Response(200,json={"choices":[{}]}),
                         Settings(llm_api_key="test-key",llm_model="test-deepseek",llm_thinking_profile="deepseek_disabled"))
    try:
        assert gateway.thinking()=={"thinking":{"type":"disabled"}}
        assert "enable_thinking" not in gateway.thinking()
    finally:gateway.close()


def test_active_natural_language_requests_remaining_proposals_and_keeps_completed(api):
    from datetime import datetime
    client,pref,app=api
    route=client.post('/api/v1/routes',json=pref).json()['data']
    active=client.post('/api/v1/routes/'+route['route_id']+'/start',json={'base_revision':1}).json()['data']
    first=route['stops'][0]
    progressed=client.post('/api/v1/routes/'+route['route_id']+'/progress',json={
        'base_revision':active['revision'],'completed_place_ids':[first['place_id']],
        'effective_at':first['departure_at']}).json()['data']
    install_parser(app,[{'operations':[{'type':'update_preferences','evidence':'还剩两小时',
        'duration_scope':'remaining','patch':{'max_duration_s':7200,'planning_style':'less_walking'}}]}])
    response=client.post('/api/v1/chat',json={'text':'还剩两小时','route_id':route['route_id'],
       'base_revision':progressed['revision'],'effective_at':first['departure_at'],'replan_origin':'last_completed'})
    assert response.status_code==200,response.text
    data=response.json()['data']
    assert data['status']=='proposal' and data['replan_proposals']
    assert data['tool_trace'][0]['name']=='replan_remaining_route'
    elapsed=int((datetime.fromisoformat(first['departure_at'])-datetime.fromisoformat(route['departure_at'])).total_seconds())
    assert data['preferences']['max_duration_s']==7200+elapsed
    assert all(p['route']['stops'][0]==first for p in data['replan_proposals'])
    assert client.get('/api/v1/routes/'+route['route_id']).json()['data']['revision']==progressed['revision']
