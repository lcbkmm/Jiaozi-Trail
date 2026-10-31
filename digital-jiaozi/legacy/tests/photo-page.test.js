import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const pageFile=new URL('../miniprogram/packages/digital-jiaozi/pages/photo/index.js',import.meta.url);
async function photoPage(request,accepted=false) {
  let definition;
  const wx={setStorageSync(){},showToast(){},showModal({success}){success({confirm:accepted});}};
  const cropBox={module:{exports:{}}};
  vm.runInNewContext(await fs.readFile(new URL('../../services/crop-math.js',pageFile),'utf8'),cropBox);
  const crop=cropBox.module.exports,pageBox={module:{exports:{}},wx,require:()=>({request,key:()=> 'test-key'})};
  vm.runInNewContext(await fs.readFile(new URL('../../services/page.js',pageFile),'utf8'),pageBox);
  const services=pageBox.module.exports,run=services.run;let pending;
  services.run=(...args)=>(pending=run(...args));
  vm.runInNewContext(await fs.readFile(pageFile,'utf8'),{
    Page:value=>{definition=value;},wx,
    require:id=>id==='../../services/page'?services:crop
  },{filename:pageFile.pathname});
  return {...definition,data:structuredClone(definition.data),setData(patch){Object.assign(this.data,patch);},invoke(name){this[name]();return pending;}};
}
const job=()=>({id:'job-1',status:'DRAFT',width:720,height:480,error:null,draft:{title:'旅途记忆',category:'other',threshold:140,mode:'tone',polarity:'dark',crop:{x:0,y:0,size:1}}});
function edited(page) {
  page.useJob(job());
  page.setData({title:'我填写的名字',categoryIndex:1,threshold:80,modeIndex:1,polarity:true,dirty:true});
  page.crop={...page.crop,scale:page.crop.scale*2,left:-160,top:-120};
  return JSON.stringify(page.crop);
}
test('照片页识别失败或拒绝建议保留未保存的字段/裁剪，接受建议只改名称和类别',async()=>{
  for(const [analysisStatus,accepted] of [['FAILED',false],['SUCCEEDED',false],['SUCCEEDED',true]]) {
    const result={...job(),status:'AWAITING_CONFIRMATION',analysisStatus,error:analysisStatus==='FAILED'?'未启用自动识别':null,analysis:{suggestedTitle:'建议名称',category:'building'}};
    const page=await photoPage(async()=>({data:result}),accepted),before=edited(page);
    await page.invoke('analyze');
    assert.equal(page.data.job.analysisStatus,analysisStatus);
    assert.equal(page.data.title,accepted?'建议名称':'我填写的名字');
    assert.equal(page.data.categoryIndex,accepted?0:1);
    assert.equal(page.data.threshold,80);assert.equal(page.data.modeIndex,1);assert.equal(page.data.polarity,true);
    assert.equal(page.data.dirty,true);assert.equal(JSON.stringify(page.crop),before);
  }
});
test('照片页旋转重置裁剪而保留用户名称和处理参数，必须重新预览',async()=>{
  const rotated={...job(),width:480,height:720,previewUrl:null};
  const page=await photoPage(async()=>({data:rotated})),before=edited(page);
  await page.invoke('rotate');
  assert.equal(page.crop.width,480);assert.equal(page.crop.height,720);assert.notEqual(JSON.stringify(page.crop),before);
  assert.equal(page.data.title,'我填写的名字');assert.equal(page.data.categoryIndex,1);assert.equal(page.data.threshold,80);
  assert.equal(page.data.modeIndex,1);assert.equal(page.data.polarity,true);assert.equal(page.data.dirty,true);
});
test('照片页双指转单指不跳位，手势取消后不再响应旧触点',async()=>{
  const page=await photoPage();page.useJob(job());
  const touches=(...points)=>({touches:points.map(([clientX,clientY])=>({clientX,clientY}))});
  page.start(touches([100,100],[200,100]));page.move(touches([80,100],[220,100]));
  const before={...page.crop};page.end(touches([220,100]));page.move(touches([230,100]));
  assert.equal(page.crop.left,before.left+10);assert.equal(page.crop.top,before.top);assert.equal(page.crop.scale,before.scale);
  page.end(touches());const stopped=JSON.stringify(page.crop);page.move(touches([300,100]));assert.equal(JSON.stringify(page.crop),stopped);
});
test('照片页生成预览期间不能改变字段或裁剪，避免请求完成覆盖新编辑',async()=>{
  const page=await photoPage();page.useJob(job());page.setData({busy:true});
  const before=JSON.stringify(page.crop);
  page.field({currentTarget:{dataset:{field:'title'}},detail:{value:'不应写入'}});
  page.start({touches:[{clientX:100,clientY:100}]});page.move({touches:[{clientX:110,clientY:100}]});
  assert.equal(page.data.title,'旅途记忆');assert.equal(JSON.stringify(page.crop),before);
});
