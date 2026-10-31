import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { root } from '../server/config.js';
import { createDigitalJiaozi } from '../server/index.js';
import { synthetic } from '../scripts/fixtures.mjs';
export const activity='chengdu_demo';
export async function harness(t, overrides={}) {
  await fs.mkdir(path.join(root,'var/tests'),{recursive:true});
  const dataDir=await fs.mkdtemp(path.join(root,'var/tests/run-'));
  let now=Date.parse('2026-10-31T04:00:00Z');
  const config={demo:true,dataDir,clock:()=>now,staffSecret:'test-staff-secret-long',internalSecret:'test-internal-secret-long',...overrides};
  let m=await createDigitalJiaozi({config});
  const app=express();app.use('/api/digital-jiaozi/v1',(req,res,next)=>m.router(req,res,next));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const origin=`http://127.0.0.1:${server.address().port}`;m.config.publicUrl=origin;
  t.after(async()=>{await new Promise(r=>server.close(r));m.repo.close();await fs.rm(dataDir,{recursive:true,force:true});});
  async function call(url,method='GET',body,token='demo-a',headers={}) {
    const response=await fetch(origin+'/api/digital-jiaozi/v1'+url,{method,headers:{...(body instanceof FormData?{}:{'content-type':'application/json'}),...(token?{authorization:`Bearer ${tokens[token]||token}`} : {}),...headers},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
    const json=await response.json();return {status:response.status,...json};
  }
  const tokens={};for(const account of ['demo-a','demo-b','staff']) {
    const r=await call('/demo/session','POST',{account,...(account==='staff'?{staffSecret:config.staffSecret}:{})},null);
    tokens[account]=r.data.token;
  }
  return {get m(){return m;},call,origin,tokens,get now(){return now;},set now(v){now=v;},
    async restart(){m.repo.close();m=await createDigitalJiaozi({config:{...config,publicUrl:origin}});},
    init(user='demo-a'){return m.commerce.initialize(user,activity);},
    event(type,source,user='demo-a',extra={}){return m.commerce.event({eventId:randomUUID(),type,userId:user,activityId:activity,occurredAt:new Date(now).toISOString(),source:{recordId:randomUUID(),...source},...extra},'test');},
    async draft(user='demo-a',bytes){
      const j=await m.jobs.upload(user,activity,bytes||await synthetic(),randomUUID());
      return m.jobs.draft(user,j.id,{...j.draft,title:'成都旅途',crop:{x:0,y:0,size:1}});
    }
  };
}
