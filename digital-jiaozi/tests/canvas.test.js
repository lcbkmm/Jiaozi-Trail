import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createCanvas, Image, GlobalFonts } from '@napi-rs/canvas';
import sharp from 'sharp';
import { root, rules } from '../server/config.js';
import { harness,activity } from './helpers.js';
import { selectAsset } from '../scripts/asset-selection.mjs';
test('执行实际 Canvas 导出函数：远程照片章、失败回退、分页和共享几何',async t=>{
  const h=await harness(t);h.init();const j=await h.draft();await h.m.jobs.generate('demo-a',j.id,randomUUID());h.m.jobs.attach('demo-a',j.id);
  await h.restart();
  const picture=h.m.jobs.view('demo-a',j.id).resultUrl;
  GlobalFonts.registerFromPath(path.join(root,'server/fonts/NotoSansCJKsc-Regular.otf'),'sans-serif');
  const output=path.join(root,'var/qa');await fs.mkdir(output,{recursive:true});
  const native=createCanvas(1200,1000),canvas={get width(){return native.width;},set width(v){native.width=v;},get height(){return native.height;},set height(v){native.height=v;},getContext:()=>native.getContext('2d'),createImage:()=>new Image()};
  let downloads=0,failures=0;
  const wx={
    createSelectorQuery(){return {in(){return this;},select(){return this;},fields(){return this;},exec(callback){callback([{node:canvas}]);}};},
    downloadFile({url,success,fail}){downloads++;(async()=>{const response=await fetch(url);if(!response.ok){failures++;success({statusCode:response.status});return;}const file=path.join(output,'download-'+randomUUID()+'.png');await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));success({statusCode:200,tempFilePath:file});})().catch(fail);},
    canvasToTempFilePath({success}){const file=path.join(output,'canvas-export.png');fs.writeFile(file,native.toBuffer('image/png')).then(()=>success({tempFilePath:file}));}
  };
  const base=path.join(root,'miniprogram/packages/digital-jiaozi'),cache={};
  async function read(file){const context={module:{exports:{}},wx,require:id=>{
    const p=path.resolve(path.dirname(file),id);
    if(p.endsWith('asset-manifest.json')){const a=createRequire(file)(id);return Object.fromEntries(Object.entries(a).map(([key,value])=>[key,{...value,path:path.join(root,'miniprogram',value.path)}]));}
    if(cache[p+'.js'])return cache[p+'.js'];return createRequire(file)(id);
  }};vm.runInNewContext(await fs.readFile(file,'utf8'),context,{filename:file});return context.module.exports;}
  cache[path.join(base,'services/card-layout.js')]=await read(path.join(base,'services/card-layout.js'));
  const card=await read(path.join(base,'services/card.js')),layout=cache[path.join(base,'services/card-layout.js')];
  const overview=h.m.commerce.overview('demo-a',activity);overview.stamps=Array.from({length:7},(_,i)=>({title:`照片记忆${i+1}`,imageUrl:i===1?h.origin+'/missing.png':picture}));
  const png=await card.exportPage({},overview,0),meta=await sharp(png).metadata();assert.equal(meta.width,1200);assert.equal(meta.height,1000);assert.equal(downloads,6);assert.equal(failures,1);
  const pixel=await sharp(png).extract({left:170,top:300,width:200,height:120}).raw().toBuffer();assert.ok(pixel.some((v,i)=>i%3===0&&v<200));
  assert.equal(card.cells(overview.stamps,1)[0].stamp.title,'照片记忆7');assert.equal(card.cells(overview.stamps,1)[1].stamp,null);
  for(const g of layout.geometry(343)){assert.ok(g.size>40);assert.ok(g.nameTop+g.nameHeight<=g.h+1e-9);assert.ok(g.y+g.h<=343*2/3*.8);}
  assert.equal(rules.slots[0].y,.215);assert.equal(rules.slots[3].y,.535);
  const box=layout.contain(1264,848,0,0,1200,800);assert.ok(Math.abs(box.w/box.h-1264/848)<1e-9);assert.ok(box.x>0);
});
test('素材过滤排除探针/无目标/未处理备注，不能只依赖 selected',()=>{
  const record={assetId:'B01',selected:true,targetPath:'cards/jiaozi.png',qaStatus:'PASS_WITH_NOTE',qaNote:'章位已调整'},decisions={B01:{qaNote:'章位已调整',resolution:'已同步验证'}};
  assert.equal(selectAsset(record,decisions,['B01']),null);
  for(const entry of [{...record,assetId:'F03-PROBE'},{...record,qaStatus:'PASS_AS_PROBE'},{...record,targetPath:null},{...record,qaNote:'需要重新验收'}])assert.ok(selectAsset(entry,decisions,['B01']));
});
