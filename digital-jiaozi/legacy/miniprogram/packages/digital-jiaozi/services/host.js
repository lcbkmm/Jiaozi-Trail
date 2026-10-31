const environment=require('../config/environment');
// Replace these functions at integration with the host's existing login/navigation contract.
// The default is a clearly enabled DEMO session, never wx.login or a second production account.
module.exports={
  config:environment,
  getSession(staff){return wx.getStorageSync(staff?'dj:staff-session':'dj:session')||null;},
  saveDemoSession(session,staff){wx.setStorageSync(staff?'dj:staff-session':'dj:session',session);},
  activityId(){return environment.activityId;},
  async navigateTask(kind,id){wx.showToast({title:'宿主'+kind+'入口尚未接入',icon:'none'});},
  leave(){wx.navigateBack({fail:()=>wx.showToast({title:'请从宿主入口进入',icon:'none'})});}
};
