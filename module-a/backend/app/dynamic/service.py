from __future__ import annotations
import copy
from datetime import datetime, timedelta, timezone
from pydantic import ValidationError
from app.errors import AppError
from app.goals import covered, sequence_progress
from app.schemas import Preferences


class DynamicPlanning:
    PATCH_KEYS={'max_duration_s','budget_per_person_fen','max_walk_m','max_queue_s','buffer_s',
                'interests','required_experiences','required_goals','visit_sequence','visit_mode','category_limits','excluded_interests','must_visit_ids','excluded_place_ids','planning_style'}

    def __init__(self,database,repository,tools):
        self.database,self.repository,self.tools=database,repository,tools

    def update_position(self,token,position):
        now=datetime.now(timezone.utc)
        age=(now-position.observed_at).total_seconds()
        if age>120 or age < -10:raise AppError('STALE_POSITION','定位超过两分钟或时间异常，请刷新定位。',422)
        if position.accuracy_m>100 and not position.confirmed:
            raise AppError('POSITION_CONFIRMATION_REQUIRED','定位误差较大，请重新定位或确认所在位置。',422)
        if position.source in {'manual','demo'} and not position.confirmed:
            raise AppError('POSITION_CONFIRMATION_REQUIRED','手选或演示位置需要明确确认。',422)
        catalog=self.tools.catalog()
        if not catalog.places or not catalog.nearby_ids(position,3000):
            raise AppError('OUTSIDE_SERVICE_AREA','当前位置超出当前候选商圈，请选择商圈内起点。',422)
        return self.repository.update_position(token,position.model_dump(mode='json'))

    def states(self,token):return self.repository.snapshot(token)

    def event(self,token,event):
        if event.place_id not in self.tools.catalog().places:
            raise AppError('RESOURCE_NOT_FOUND','未知商家点位。',404)
        return self.repository.update_state(token,event)

    def progress(self,token,route_id,body):
        route=self.database.route(token,route_id)
        fingerprint=body.model_dump(mode='json',exclude={'base_revision'})
        if route.get('last_progress_report')==fingerprint:return route
        if route['revision']!=body.base_revision:raise AppError('STALE_REVISION','行程版本已变化。',409)
        if route['status']!='active':raise AppError('INVALID_ROUTE_STATE','请先开始行程再上报进度。',409)
        planned=[s['place_id'] for s in route['stops']]
        completed=body.completed_place_ids
        old=route.get('progress',{}).get('completed_place_ids',[])
        if len(set(completed))!=len(completed) or completed!=planned[:len(completed)] or completed[:len(old)]!=old:
            raise AppError('INVALID_PROGRESS','已完成点必须是当前行程的连续前缀，且不能撤销原有进度。',422)
        departure=datetime.fromisoformat(route['departure_at'])
        previous=datetime.fromisoformat(route.get('progress',{}).get('effective_at',route['departure_at']))
        if body.effective_at<previous or body.effective_at<departure:
            raise AppError('INVALID_PROGRESS','进度时间不能倒退。',422)
        if body.spent_per_person_fen is not None and body.spent_per_person_fen<route.get('progress',{}).get('spent_per_person_fen',0):
            raise AppError('INVALID_PROGRESS','累计已消费金额不能减少。',422)
        if body.actual_walk_m is not None and body.actual_walk_m<route.get('progress',{}).get('walked_m',0):
            raise AppError('INVALID_PROGRESS','累计步行不能减少。',422)
        estimated_cost=sum(s['cost_max_per_person_fen'] for s in route['stops'][:len(completed)])
        estimated_walk=sum(route.get('history_legs',route['legs'])[i]['distance_m'] for i in range(min(len(completed),len(route.get('history_legs',route['legs'])))))
        previous_progress=route.get('progress',{})
        route['progress']={'completed_place_ids':completed,'effective_at':body.effective_at.isoformat(),
            'spent_per_person_fen':body.spent_per_person_fen if body.spent_per_person_fen is not None else max(estimated_cost,previous_progress.get('spent_per_person_fen',0)),
            'cost_source':'self_reported' if body.spent_per_person_fen is not None else 'conservative_estimate',
            'walked_m':body.actual_walk_m if body.actual_walk_m is not None else max(estimated_walk,previous_progress.get('walked_m',0)),
            'walk_source':'self_reported' if body.actual_walk_m is not None else 'completed_legs_estimate',
            'verification':body.source}
        route['last_progress_report']=fingerprint
        route['revision']+=1
        return self.repository.commit_route(token,route,body.base_revision)

    def assess(self,token,route_id):
        route=self.database.route(token,route_id)
        snapshot=self.repository.snapshot(token)
        completed=route.get('progress',{}).get('completed_place_ids',[])
        reasons=[];warnings=[];extra_queue=0
        for stop in route['stops'][len(completed):]:
            state=snapshot['states'].get(stop['place_id'],{})
            if state.get('status')=='closed':
                reasons.append({'type':'closed','place_id':stop['place_id'],'message':stop['name']+'临时关闭'})
            new_queue=state.get('queue_s',stop['queue_duration_s'])
            extra_queue+=max(0,new_queue-stop['queue_duration_s'])
            if new_queue>route['preferences']['max_queue_s']:
                reasons.append({'type':'queue_limit','place_id':stop['place_id'],'queue_s':new_queue,
                                'message':stop['name']+'预计排队超过用户上限'})
            elif new_queue-stop['queue_duration_s']>=600:
                reasons.append({'type':'queue_increased','place_id':stop['place_id'],'queue_s':new_queue,
                                'message':stop['name']+'预计排队增加至少十分钟'})
            if state.get('inventory_status')=='sold_out':
                warnings.append({'type':'benefit_sold_out','place_id':stop['place_id'],
                                 'message':stop['name']+'福利售罄；仍可到访，但不可承诺领取'})
        planned_duration=int((datetime.fromisoformat(route['planned_end_at'])-datetime.fromisoformat(route['departure_at'])).total_seconds())
        if planned_duration+extra_queue>route['preferences']['max_duration_s']:
            reasons.append({'type':'time_overrun','message':'更新后的排队可能使原行程超过时间上限'})
        position=snapshot.get('position')
        position_ready=bool(position and (datetime.now(timezone.utc)-datetime.fromisoformat(position['observed_at'])).total_seconds()<=120)
        return {'route_id':route_id,'route_revision':route['revision'],'state_version':snapshot['state_version'],
                'position_revision':snapshot['position_revision'],'replan_suggested':bool(reasons),
                'reasons':reasons,'warnings':warnings,'position_ready':position_ready,
                'requires_confirmation':True,'route_modified':False,
                'notice':'这是规则风险提示；实际替代路线仍需调用 replan，接受前不改变行程。'}

    async def replan(self,token,route_id,body):
        route=self.database.route(token,route_id)
        if route['status'] not in {'planned','active'}:raise AppError('INVALID_ROUTE_STATE','已结束的行程不能重排。',409)
        if route['revision']!=body.base_revision:raise AppError('STALE_REVISION','路线已变化，请重新读取。',409)
        if set(body.preference_patch)-self.PATCH_KEYS:
            raise AppError('INVALID_INPUT','本次修改包含不支持的行程字段。',422)
        original=copy.deepcopy(route['preferences'])
        original.update(body.preference_patch)
        try:total=Preferences.model_validate(original)
        except ValidationError:raise AppError('INVALID_INPUT','重排条件无效或互相冲突。',422) from None
        start_time=datetime.fromisoformat(route['departure_at'])
        progress=route.get('progress',{})
        completed=progress.get('completed_place_ids',[])
        minimum_time=datetime.fromisoformat(progress.get('effective_at',route['departure_at']))
        if body.effective_at<minimum_time:raise AppError('INVALID_INPUT','重排时间不能早于已记录进度。',422)
        elapsed=int((body.effective_at-start_time).total_seconds())
        if elapsed<0:raise AppError('INVALID_INPUT','重排时间不能早于出发时间。',422)
        spent=progress.get('spent_per_person_fen',0);walked=progress.get('walked_m',0)
        remaining_s=total.max_duration_s-elapsed
        if remaining_s<0 or spent>total.budget_per_person_fen or walked>total.max_walk_m:
            raise AppError('NO_FEASIBLE_ROUTE','剩余时间不足或已用预算/步行超过上限，请明确调整约束。',422,
                           {'remaining_s':remaining_s,'spent_per_person_fen':spent,'walked_m':walked})
        catalog=self.tools.catalog()
        completed_stops=[catalog.stops[pid] for pid in completed if pid in catalog.stops]
        fulfilled={tag for stop in completed_stops for tag in stop.interests}
        progress_index=sequence_progress(total.visit_sequence,completed_stops)
        if progress_index<0:
            raise AppError('NO_FEASIBLE_ROUTE','已完成行程与新增顺序要求冲突，请调整顺序。',422)
        remaining=total.model_dump(mode='json')
        remaining.update(departure_at=body.effective_at.isoformat(),max_duration_s=remaining_s,
            budget_per_person_fen=total.budget_per_person_fen-spent,max_walk_m=total.max_walk_m-walked,
            must_visit_ids=[p for p in total.must_visit_ids if p not in completed],
            required_experiences=[tag for tag in total.required_experiences if tag not in fulfilled],
            required_goals=[goal.model_dump() for goal in total.required_goals if not covered(goal,completed_stops)],
            visit_sequence=[goal.model_dump() for goal in total.visit_sequence[progress_index:]],
            excluded_place_ids=list(total.excluded_place_ids),use_current_position=False)
        if body.origin=='last_completed':
            if not completed:raise AppError('POSITION_REQUIRED','还没有已完成点，请上报当前位置或确认起点。',422)
            remaining['start_place_id']=completed[-1]
        elif body.origin=='planned_start':
            if route['status']=='active':raise AppError('POSITION_REQUIRED','行程已开始，请使用当前位置或确认最后完成点。',422)
            remaining['start_place_id']=total.start_place_id
        else:remaining['use_current_position']=True
        snapshot=self.repository.snapshot(token)
        # Remaining time may legitimately be below the public 15-minute minimum.
        remaining_preferences=Preferences.model_validate({**remaining,'max_duration_s':max(900,remaining_s)})
        remaining_preferences=remaining_preferences.model_copy(update={'max_duration_s':remaining_s})
        all_completed=len(completed)==len(route['stops'])
        has_goals=bool(remaining['required_experiences'] or remaining['must_visit_ids'] or remaining['required_goals'] or remaining['visit_sequence'])
        capacity=max(0,5-len(completed))
        if remaining_s<900 or (all_completed and not has_goals): capacity=0
        plan=await self.tools.plan(remaining_preferences,token=token,include_options=True,
            max_stops=capacity,allow_empty=True,completed_place_ids=completed,
            completed_categories=[s["category"] for s in route["stops"][:len(completed)]])
        # Re-read route/state after awaiting network before storing a proposal.
        if self.database.route(token,route_id)['revision']!=body.base_revision:
            raise AppError('STALE_REVISION','计算期间行程变化，请重试。',409)
        latest=self.repository.snapshot(token)
        if self.tools.catalog().version!=catalog.version or any(latest[k]!=snapshot[k] for k in ('state_version','position_revision')):
            raise AppError('STALE_PROPOSAL','计算期间位置或商家状态变化，请重试。',409)
        proposals=[]
        old_remaining=[p for p in [s['place_id'] for s in route['stops']] if p not in completed]
        prefix=copy.deepcopy(route['stops'][:len(completed)])
        for option in plan['options']:
            updated=copy.deepcopy(route)
            remaining_totals=option['totals']
            updated.update(catalog_version=catalog.version,stops=prefix+option['stops'],stop_ids=[s['stop_id'] for s in prefix+option['stops']],
                legs=option['legs'],history_legs=copy.deepcopy(route.get('history_legs',route['legs'])[:len(completed)])+option['legs'],
                remaining_totals=remaining_totals,remaining_departure_at=body.effective_at.isoformat(),
                planned_end_at=option['planned_end_at'],preferences={**total.model_dump(mode='json'),
                    'planning_style':option['preferences']['planning_style']},
                state_version=snapshot['state_version'],position_revision=snapshot['position_revision'],
                warnings=option['warnings'],sources=option['sources'],planner=option['planner'],
                planning_outcome=option.get('planning_outcome','visits'),
                status='completed' if option.get('planning_outcome')=='completed' else route['status'])
            completed_components={key:sum(stop[key] for stop in prefix) for key in ('walk_duration_s','wait_duration_s','queue_duration_s','dwell_duration_s')}
            adjustment=elapsed-sum(completed_components.values())
            updated['totals']={**remaining_totals,
                **{key:remaining_totals[key]+completed_components[key] for key in completed_components},
                'elapsed_adjustment_s':adjustment,'duration_s':elapsed+remaining_totals['duration_s'],
                'elapsed_duration_s':elapsed,'remaining_duration_s':remaining_totals['duration_s'],
                'walk_distance_m':walked+remaining_totals['walk_distance_m'],
                'cost_min_per_person_fen':spent+remaining_totals['cost_min_per_person_fen'],
                'cost_max_per_person_fen':spent+remaining_totals['cost_max_per_person_fen']}
            remaining_ids=[s['place_id'] for s in option['stops']]
            diff={'removed_place_ids':[p for p in old_remaining if p not in remaining_ids],
                  'added_place_ids':[p for p in remaining_ids if p not in old_remaining],
                  'old_remaining_order':old_remaining,'new_remaining_order':remaining_ids,
                  'remaining_duration_delta_s':remaining_totals['duration_s']-max(0,int((datetime.fromisoformat(route['planned_end_at'])-body.effective_at).total_seconds())),
                  'completed_place_ids_unchanged':completed,
                  'benefit_warnings':['小样/优惠售罄的点位仍可能适合逛吃，但不可承诺领取。'] if any(
                       x.get('inventory_status')=='sold_out' for x in snapshot['states'].values()) else []}
            payload={'route':updated,'option_id':option['option_id'],'title':option['title'],
                'catalog_version':catalog.version,
                'reason':body.reason,'triggers':self.assess(token,route_id)['reasons'],'diff':diff,'requires_confirmation':True,
                'render':{'coord_system':'gcj02','origin':plan.get('origin') or {
                              'place_id':remaining['start_place_id'], 'source':'confirmed_last_completed' if body.origin=='last_completed' else 'planned_start'},
                          'remaining_place_ids':remaining_ids,'legs':option['legs'],
                          'completed_place_ids':completed}}
            proposal=self.repository.save_proposal(token,route,snapshot,
                (datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat(),payload)
            proposals.append(proposal)
        return {'proposals':proposals,'route_modified':False,'state_version':snapshot['state_version'],
                'position_revision':snapshot['position_revision']}
