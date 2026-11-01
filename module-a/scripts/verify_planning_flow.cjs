// Real prepared Baidu geometry and real API; no model call or synthetic route.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const base=process.argv.find(v=>v.startsWith('--base='))?.slice(7)||'http://127.0.0.1:8004';
let token='';
async function call(url,method='GET',body,expected=200){
  const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Demo-Session':token},
    body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value.data;
}
(async()=>{
  token=(await call('/api/v1/demo/sessions','POST',{business_now:'2026-11-01T14:00:00+08:00'},201)).session_token;
  const pref={start_place_id:'chunxi_start',departure_at:'2026-11-01T14:00:00+08:00',max_duration_s:10800,
    budget_per_person_fen:20000,max_walk_m:3000,max_queue_s:1200,interests:[],visit_mode:'focused',
    visit_sequence:[{place_ids:['ifs']},{any_of:['hotpot']}],planning_style:'less_walking'};
  const result=await call('/api/v1/route-options','POST',pref);
  assert.equal(result.recommended_id,'less_walking');
  assert.ok(result.options.every(o=>o.stops.length===2&&o.stops[0].place_id==='ifs'));
  let route=await call('/api/v1/routes','POST',result.options[0].preferences,201);
  const url='/api/v1/routes/'+route.route_id;
  route=await call(url+'/start','POST',{base_revision:route.revision});
  const first=route.stops[0],originalMeal=route.stops[1];
  route=await call(url+'/progress','POST',{base_revision:route.revision,completed_place_ids:[first.place_id],effective_at:first.departure_at});
  const state=await call('/api/v1/dynamic-state');
  await call('/api/v1/demo/events','POST',{place_id:originalMeal.place_id,base_state_version:state.state_version,queue_s:2400});
  const proposal=(await call(url+'/replan','POST',{base_revision:route.revision,effective_at:first.departure_at,origin:'last_completed'})).proposals[0];
  assert.equal(proposal.option_id,'less_walking');
  assert.deepEqual(proposal.route.stops[0],first);
  assert.notEqual(proposal.route.stops[1].place_id,originalMeal.place_id);
  assert.ok(proposal.render.legs.every(leg=>leg.source==='baidu_walking'&&leg.points.length>1));
  const acceptBody={base_revision:route.revision,proposal_id:proposal.proposal_id};
  route=await call(url+'/accept','POST',acceptBody);
  const next=route.stops[1];
  route=await call(url+'/progress','POST',{base_revision:route.revision,completed_place_ids:route.stops.map(s=>s.place_id),effective_at:next.departure_at});
  const repeated=await call(url+'/accept','POST',acceptBody);assert.equal(repeated.revision,route.revision);
  const finish=(await call(url+'/replan','POST',{base_revision:route.revision,effective_at:next.departure_at,origin:'last_completed'})).proposals[0];
  route=await call(url+'/accept','POST',{base_revision:route.revision,proposal_id:finish.proposal_id});
  assert.equal(route.status,'completed');
  await call(url+'/start','POST',{base_revision:route.revision},409);
  const alternatives=await call('/api/v1/route-options','POST',{...pref,visit_sequence:[],planning_style:'balanced',required_goals:[{any_of:['coffee','tea']}]});
  assert.ok(alternatives.options.every(o=>o.stops.length===1));
  const report={mode:'actual API and prepared Baidu geometry, no model call',passed:true,
    orderedSequence:['IFS','hotpot'],originalMeal:originalMeal.name,replacement:next.name,finalStatus:route.status,
    catalogVersion:route.catalog_version,alternativeSingleStop:true,duplicateAcceptReturnsLatest:true};
  fs.writeFileSync(path.join(__dirname,'../runtime/planning_flow_verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
