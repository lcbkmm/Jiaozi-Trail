from __future__ import annotations
import asyncio
import re
from pydantic import ValidationError
from app.errors import AppError
from app.intent.binary_backend import JevAdvisor
from app.schemas import Preferences
from app.dynamic.schemas import ReplanRequest
from datetime import datetime


class Clarify(Exception):
    pass


def canonical(text):
    return re.sub(r"[\s·（）()\-]", "", text).lower()


class IntentResolver:
    def __init__(self, database, tools, gateway):
        self.database, self.tools, self.gateway = database, tools, gateway
        self.advisor = JevAdvisor(gateway)
        self.worker_limit = asyncio.Semaphore(2)

    def resolve_place(self, query, selected, places):
        if not query or canonical(query) in {"这家", "这家店", "这里", "它", "这个地方", "这站", "当前店铺"}:
            if selected:
                return next(p for p in places if p.place_id == selected)
            raise Clarify("你指的是哪家店？请先点开一个点位，或告诉我店名。")
        normalized = canonical(query)
        aliases = {"ifs":"ifs", "熊猫":"ifs", "太古里":"taikoo", "大慈寺":"daci", "地铁站":"chunxi_start",
                   "星巴克":"coffee", "龙抄手":"longchaoshou", "小龙坎":"hotpot", "无印良品":"muji", "喜茶":"tea"}
        exact = [p for p in places if normalized in {canonical(p.place_id), canonical(p.name)}]
        alias = aliases.get(normalized)
        if not exact and alias:
            exact = [p for p in places if p.place_id==alias]
        matches = exact or [p for p in places if normalized in canonical(p.name)]
        if len(matches)==1:
            return matches[0]
        if len(matches)>1:
            raise Clarify("匹配到多家店，请明确分店："+"、".join(p.name for p in matches))
        raise Clarify("当前候选点位中没有找到“"+query+"”，请选已有点位；新地点接入后才能计算路径。")

    async def handle(self, token, request):
        context = self.database.conversation(token)
        if request.context_revision is not None and request.context_revision != context["revision"]:
            raise AppError("STALE_CONTEXT", "对话上下文已变化，请读取最新对话。", 409)
        places = self.database.places()
        if request.selected_place_id and not any(p.place_id==request.selected_place_id for p in places):
            raise AppError("INVALID_INPUT", "当前选中的地点不存在。")
        route = None
        if request.route_id:
            route = self.database.route(token, request.route_id)
            if request.base_revision != route["revision"]:
                raise AppError("STALE_REVISION", "行程版本已变化，请先更新路线。", 409)
        baseline = (route["preferences"] if route and route["status"]=="active" else
            (request.current_preferences.model_dump(mode="json") if request.current_preferences else
             (route["preferences"] if route else context["preferences"])))
        if baseline is None:
            session = self.database.session(token)
            start = "chunxi_start" if any(p.place_id=="chunxi_start" for p in places) else (places[0].place_id if places else "")
            baseline = Preferences(start_place_id=start, departure_at=session["business_now"],
                max_duration_s=10800,budget_per_person_fen=20000,interests=["coffee","food","landmark"]).model_dump(mode="json")
        try:
            baseline = Preferences.model_validate(baseline).model_dump(mode="json")
        except ValidationError:
            raise AppError("INVALID_INPUT", "当前行程条件无效。") from None
        if any(pid not in {p.place_id for p in places} for pid in [baseline["start_place_id"], *baseline["must_visit_ids"], *baseline["excluded_place_ids"]]):
            raise AppError("INVALID_INPUT", "当前行程条件包含未知地点。")
        catalog = [{"place_id":p.place_id,"name":p.name,"category":p.category} for p in places]
        async with self.worker_limit:
            parsed = await asyncio.to_thread(self.gateway.parse, request.text, baseline, catalog,
                                              context["history"], request.selected_place_id)
        # Only validated, source-evidenced ParsedTurn may cross into execution.
        from app.intent.schemas import ParsedTurn
        parsed = ParsedTurn.model_validate(parsed)
        if any(op.evidence not in request.text for op in parsed.operations):
            raise AppError("MODEL_INVALID_RESPONSE", "操作原文依据未通过校验。", 502)
        decision = {"mode":"structured_extraction", "requires_confirmation":False}
        if parsed.clarification and parsed.ambiguity_candidates:
            try:
                async with self.worker_limit:
                    decision = await asyncio.to_thread(self.advisor.advise, request.text, request.selected_place_id, parsed.ambiguity_candidates)
            except AppError as error:
                decision = {"mode":"jev_unavailable", "reason":error.code, "requires_confirmation":True}
        proposed = dict(baseline)
        proposed["must_visit_ids"] = list(baseline["must_visit_ids"])
        proposed["excluded_place_ids"] = list(baseline["excluded_place_ids"])
        calls, changes = [], []
        result = {"status":"clarify", "operations":[op.model_dump(exclude_none=True) for op in parsed.operations],
                  "preferences":baseline, "decision":decision, "tool_results":[], "tool_trace":[],
                  "route_options":None, "needs_confirmation":True, "route_modified":False,
                  "model":self.gateway.settings.llm_model}
        def add_unique(key, value):
            if value not in proposed[key]: proposed[key].append(value)
        try:
            if parsed.clarification:
                raise Clarify(parsed.clarification)
            requires_plan = False
            for op in parsed.operations:
                if op.type=="update_preferences":
                    patch = op.patch.model_dump(exclude_none=True)
                    if op.duration_scope=="remaining" and "max_duration_s" in patch and route and route["status"]=="active":
                        if request.effective_at is None:raise Clarify("请先提供当前行程时间，才能按剩余时间重新规划。")
                        elapsed=int((request.effective_at-datetime.fromisoformat(route["departure_at"])).total_seconds())
                        if elapsed<0:raise Clarify("当前行程时间不能早于出发时间。")
                        patch["max_duration_s"]+=elapsed
                    proposed.update(patch); changes.extend(patch.keys()); requires_plan=True
                elif op.type in {"require_place","insert_place","exclude_place","replace_place"}:
                    place = self.resolve_place(op.place_query, request.selected_place_id, places)
                    if op.type=="exclude_place":
                        if place.place_id in proposed["must_visit_ids"]:
                            raise Clarify(place.name+"已被设为必去，请明确是否取消必去要求。")
                        add_unique("excluded_place_ids",place.place_id)
                    elif op.type=="replace_place":
                        if place.place_id in proposed["must_visit_ids"]:
                            raise Clarify(place.name+"是必去点，请先确认是否取消保留。")
                        add_unique("excluded_place_ids",place.place_id)
                        if op.replacement_query:
                            replacement = self.resolve_place(op.replacement_query,None,places)
                            add_unique("must_visit_ids",replacement.place_id)
                        elif op.target_interest:
                            proposed["interests"] = list(dict.fromkeys([*proposed["interests"],op.target_interest]))
                        else:
                            raise Clarify("你想换成哪家店，或哪种体验？")
                    else:
                        if place.place_id in proposed["excluded_place_ids"]:
                            raise Clarify(place.name+"此前已被排除，请明确是否允许重新加入。")
                        add_unique("must_visit_ids",place.place_id)
                    changes.append(op.type+":"+place.name); requires_plan=True
                elif op.type=="get_place_details":
                    place=self.resolve_place(op.place_query, request.selected_place_id, places)
                    calls.append(("get_place_details",{"place_id":place.place_id}))
                elif op.type=="search_nearby_places":
                    anchor=self.resolve_place(op.place_query,request.selected_place_id or proposed["start_place_id"],places)
                    calls.append(("search_nearby_places",{"longitude":anchor.longitude,"latitude":anchor.latitude,
                        "radius_m":op.radius_m or 1500,"category":op.category}))
                elif op.type=="plan_routes":
                    requires_plan=True
                elif op.type=="add_memory":
                    self.resolve_place(op.place_query,request.selected_place_id,places)
                    result["status"]="not_available"
                    raise Clarify("已识别为添加个人记忆；交子与 DIY 将在下一阶段接入，本次尚未保存或发放奖励。")
            try:
                preferences=Preferences.model_validate(proposed)
            except ValidationError:
                raise Clarify("本次条件互相冲突或超过支持范围，请调整后再试。") from None
            dynamic_replan = requires_plan and route and route['status']=='active'
            if dynamic_replan:
                if request.effective_at is None:
                    raise Clarify('当前行程已开始，请随请求提供 effective_at 当前行程时间，再计算剩余路线；本次未修改行程。')
                service=getattr(self.tools,'dynamic_planning',None)
                if service is None:raise Clarify('剩余重排服务未连接。')
                patch={key:value for key,value in preferences.model_dump(mode='json').items()
                       if key in service.PATCH_KEYS and value!=baseline.get(key)}
                replanned=await service.replan(token,route['route_id'],ReplanRequest(
                    base_revision=route['revision'],effective_at=request.effective_at,
                    origin=request.replan_origin,preference_patch=patch,reason=request.text[:200]))
                result['replan_proposals']=replanned['proposals']
                result['tool_trace'].append({'name':'replan_remaining_route','status':'success'})
                result['route_options']=[{'option_id':p['option_id'],'title':p['title'],
                    'proposal_id':p['proposal_id'],**p['route']} for p in replanned['proposals']]
            elif requires_plan:
                calls.append(("plan_route_options",preferences.model_dump(mode="json")))
            if not calls and not dynamic_replan:
                raise Clarify("请告诉我想调整的条件、要查询的店，或点击快捷按钮。")
            for name,args in calls:
                value=await self.tools.call(name,args,token=token)
                result["tool_trace"].append({"name":name,"status":"success"})
                if name=="plan_route_options":result["route_options"]=value["options"]
                else:result["tool_results"].append({"name":name,"data":value})
            result.update(status="proposal" if requires_plan else "answered",preferences=preferences.model_dump(mode="json"),
                          needs_confirmation=requires_plan, changes=changes)
            if requires_plan:
                result["reply"]=("已从当前进度计算剩余路线，已完成点保持不变；请用 proposal_id 确认，原路线尚未修改。" if dynamic_replan else "已按新条件计算 "+str(len(result["route_options"]))+" 个可行方案。请确认使用；原路线和已保存记录未修改。")
            else:
                result["reply"]="已查询到点位信息。排队/营业为演示配置，人数密度尚无数据。"
            for item in result["tool_results"]:
                if item["name"]=="get_place_details":
                    detail=item["data"];queue=detail["queue"]["duration_s"]
                    result["reply"] += " "+detail["place"]["name"]+"：预计排队"+(str((queue+59)//60)+"分钟（演示）。" if queue is not None else "未知。")
                elif item["name"]=="search_nearby_places":
                    result["reply"] += " 找到 "+str(len(item["data"]))+" 个附近候选。"
        except Clarify as error:
            result["reply"]=str(error)
        except AppError as error:
            if error.code in {"POSITION_REQUIRED","STALE_POSITION","POSITION_CONFIRMATION_REQUIRED"}:
                result.update(status="clarify",reply=error.message)
            elif error.code!="NO_FEASIBLE_ROUTE":raise
            else:
                result.update(status="no_feasible_route",reply=error.message,conflicts=error.details)
        # No actual route mutation. Keep unsuccessful patches out of the next baseline.
        history=[*context["history"],{"role":"user","text":request.text},
                 {"role":"assistant","text":result["reply"],"status":result["status"]}]
        result["context_revision"]=self.database.save_conversation(token,context["revision"],result["preferences"],history)
        return result
