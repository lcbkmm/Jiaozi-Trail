const {api,activity,run}=require('../../services/page');
Page({
  data:{busy:false,error:'',tasks:null},onLoad(){run(this,()=>this.load());},
  async load(){const r=await api.request(`/activities/${activity()}/tasks`);this.setData({tasks:r.data});},
  daily(){run(this,async()=>{const r=await api.request(`/activities/${activity()}/daily-checkin`,'POST',{});wx.showToast({title:r.data.awarded?'签到成功':'今日已签到',icon:'none'});await this.load();});},
  host(e){api.host.navigateTask(e.currentTarget.dataset.kind,e.currentTarget.dataset.id);},
  demo(e){run(this,async()=>{
    const {type,id,field}=e.currentTarget.dataset,body={activityId:api.host.activityId(),type};body[field]=id;
    const r=await api.request('/demo/events','POST',body);wx.showToast({title:r.data.duplicate?'已处理，不重复奖励':r.data.dailyCapped?'今日积分上限；地点章仍记录':`演示奖励 +${r.data.awarded}`,icon:'none'});await this.load();
  });},refresh(){run(this,()=>this.load());}
});
