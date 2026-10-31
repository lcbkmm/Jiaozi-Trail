const api=require('./api');
function activity(){return encodeURIComponent(api.host.activityId());}
async function run(page,fn){
  if(page.data.busy)return;page.setData({busy:true,error:''});
  try{return await fn();}catch(e){page.setData({error:e.message||'暂时失败，请重试'});wx.showToast({title:e.message||'操作失败',icon:'none',duration:3000});}
  finally{page.setData({busy:false});}
}
const go=name=>wx.navigateTo({url:`/packages/digital-jiaozi/pages/${name}/index`});
function confirm(content){return new Promise(resolve=>wx.showModal({title:'请确认',content,success:r=>resolve(r.confirm),fail:()=>resolve(false)}));}
const time=ms=>new Date(ms).toLocaleString();
module.exports={api,activity,run,go,confirm,time};
