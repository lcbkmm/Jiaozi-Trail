// Real API/model smoke with a wx adapter. This does not replace a phone/IDE test.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const pagePath=path.join(root,'miniprogram/pages/explore/index.js');
const storage=new Map(),modalJobs=[],notices=[];
let definition;
const base=process.argv.find(v=>v.startsWith('--base='))?.slice(7)||'http://127.0.0.1:8004';
const context={require:createRequire(pagePath),Page(v){definition=v;},getApp(){return {globalData:{apiBase:base}};},console,
  wx:{getStorageSync(k){return storage.get(k);},setStorageSync(k,v){storage.set(k,v);},showToast(v){notices.push(v);},
    showModal(v){notices.push(v);if(v.success)modalJobs.push(Promise.resolve(v.success({confirm:true})));},
    request(o){fetch(o.url,{method:o.method,headers:o.header,body:o.data===undefined?undefined:JSON.stringify(o.data)})
      .then(async r=>o.success({statusCode:r.status,data:await r.json()})).catch(()=>o.fail());}}};
vm.runInNewContext(fs.readFileSync(pagePath,'utf8'),context,{filename:pagePath});
const page=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data))});
page.setData=p=>Object.assign(page.data,p);
const report={mode:'live API + actual configured model; wx adapter, no native device claim',steps:[]};
const record=(step,extra={})=>{report.steps.push({step,...extra});console.log(JSON.stringify({step,...extra}));};
(async()=>{
  page.onLoad();await page.connect();assert.equal(page.data.online,true,JSON.stringify(notices));
  page.confirmDemoPosition();await Promise.all(modalJobs.splice(0));assert.equal(page.data.positionMode,'current_position');
  page.data.chatText='我想吃火锅，只吃这一顿，不逛街，预算200元，三小时。';
  await page.sendChat();assert.ok(page.data.chatPending,page.data.chatNotice);
  const pending=page.data.chatPending;
  assert.ok(pending.preferences.required_experiences.includes('hotpot'));
  assert.equal(pending.preferences.visit_mode,'focused');
  assert.ok(pending.route_options.every(o=>o.stops.length===1));
  await page.applyChatProposal();await page.startRoute();assert.equal(page.savedRoute.status,'active');
  const original=page.savedRoute;record('hotpot_single_stop',{places:original.stops.map(s=>s.name)});
  await page.simulateQueue();
  page.data.chatText='这家排太久了，换一家火锅，尽量少走路。';await page.sendChat();
  assert.ok(page.data.chatPending?.replan_proposals?.length,page.data.chatNotice);
  assert.equal(page.savedRoute.revision,original.revision);
  await page.applyChatProposal();assert.equal(page.savedRoute.revision,original.revision+1);
  assert.notEqual(page.savedRoute.stops[0].place_id,original.stops[0].place_id);
  assert.ok(page.savedRoute.preferences.required_experiences.includes('hotpot'));
  record('confirmed_same_category_replacement',{places:page.savedRoute.stops.map(s=>s.name)});
  await page.completeNextStop();assert.equal(page.data.completedCount,1);
  const beforeFinish=page.savedRoute;await page.replanNow();
  assert.equal(page.data.chatPending.replan_proposals[0].route.status,'completed');
  await page.applyChatProposal();assert.equal(page.savedRoute.status,'completed');
  assert.deepEqual(page.savedRoute.stops,beforeFinish.stops);record('completed_without_extra_visits');
  // A second real-API scenario verifies prefix preservation in the page and rendered coordinates.
  await page.connect();
  page.data.chatText='只去IFS，其他先不安排。';await page.sendChat();
  assert.ok(page.data.chatPending,page.data.chatNotice);
  await page.applyChatProposal();await page.startRoute();
  assert.equal(page.savedRoute.stops.length,1);
  assert.equal(page.savedRoute.stops[0].place_id,'ifs');
  await page.completeNextStop();const first=page.savedRoute.stops[0];
  page.data.chatText='接下来我想吃火锅。';await page.sendChat();
  assert.ok(page.data.chatPending?.replan_proposals?.length,page.data.chatNotice);
  await page.applyChatProposal();
  assert.equal(page.savedRoute.stops.length,2);
  const oldMeal=page.savedRoute.stops[1];await page.simulateQueue();await page.replanNow();
  assert.ok(page.data.chatPending?.replan_proposals?.length,page.data.dynamicNotice);
  const revision=page.savedRoute.revision;await page.applyChatProposal();
  assert.equal(page.savedRoute.revision,revision+1);assert.deepEqual(page.savedRoute.stops[0],first);
  assert.notEqual(page.savedRoute.stops[1].place_id,oldMeal.place_id);
  assert.equal(page.savedRoute.legs.length,1);assert.equal(page.data.markers.length,2);
  const destination=page.places.find(p=>p.place_id===page.savedRoute.stops[1].place_id);
  assert.equal(page.data.markers[1].longitude,destination.longitude);
  record('completed_prefix_and_remaining_map',{completed:first.name,next:page.savedRoute.stops[1].name,remainingLegs:page.savedRoute.legs.length});
  fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
  fs.writeFileSync(path.join(root,'runtime/dynamic_demo_verification.json'),JSON.stringify(report,null,2)+'\n');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
