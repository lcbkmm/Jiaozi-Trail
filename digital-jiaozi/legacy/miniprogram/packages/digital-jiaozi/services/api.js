const host=require('./host');
let sequence=0;
const key=()=>`dj-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;
function decode(result){
  const body=typeof result.data==='string'?JSON.parse(result.data):result.data;
  if(result.statusCode>=400||body.code!=='OK'){const error=new Error(body.message||'请求失败');error.code=body.code;throw error;}
  return {data:body.data,serverTime:body.serverTime};
}
async function request(path,method='GET',data,options={}){
  const session=await host.getSession(options.staff);
  return new Promise((resolve,reject)=>wx.request({url:host.config.baseUrl+path,method,data,timeout:60000,header:{'Content-Type':'application/json',Authorization:session?`Bearer ${session.token}`:'','Idempotency-Key':options.key||key()},
    success:r=>{try{resolve(decode(r));}catch(e){reject(e);}},fail:()=>reject(new Error('无法连接服务，请检查地址、HTTPS 与合法域名'))}));
}
async function loginDemo(account,staffSecret){
  if(!host.config.demo)throw new Error('演示登录已关闭，请使用宿主登录');
  const r=await request('/demo/session','POST',{account,...(staffSecret?{staffSecret}:{})});host.saveDemoSession(r.data,account==='staff');return r.data;
}
async function upload(activity,path,idempotencyKey){
  const session=await host.getSession();
  return new Promise((resolve,reject)=>wx.uploadFile({url:host.config.baseUrl+`/activities/${encodeURIComponent(activity)}/stamp-jobs`,filePath:path,name:'photo',timeout:60000,header:{Authorization:session?`Bearer ${session.token}`:'','Idempotency-Key':idempotencyKey||key()},success:r=>{try{resolve(decode(r));}catch(e){reject(e);}},fail:()=>reject(new Error('照片上传失败，可重试'))}));
}
module.exports={request,loginDemo,upload,key,host};
