const {api,activity,run,go}=require('../../services/page');const card=require('../../services/card');
Page({
  data:{busy:false,error:'',overview:null,needsClaim:false,page:0,pageCount:1,cells:[],title:'',exportPath:''},
  async onLoad(query){this.demoAccount=query.demoAccount;await run(this,async()=>{if(this.demoAccount)await api.loginDemo(this.demoAccount);await this.load();});},
  onShow(){if(this.loaded)run(this,()=>this.load());},
  async load(){
    try{const r=await api.request(`/activities/${activity()}/overview`);this.setData({overview:r.data,title:r.data.title,needsClaim:false});this.updatePage();}
    catch(e){if(e.code==='WALLET_REQUIRED')this.setData({needsClaim:true});else throw e;}this.loaded=true;
  },
  refresh(){run(this,()=>this.load());},
  claim(){run(this,async()=>{await api.request('/wallets/initialize','POST',{activityId:api.host.activityId()});await this.load();});},
  updatePage(){const count=Math.max(1,Math.ceil(this.data.overview.stamps.length/6)),p=Math.min(this.data.page,count-1);this.setData({page:p,pageCount:count,cells:card.cells(this.data.overview.stamps,p)});},
  flip(e){this.setData({page:Math.max(0,Math.min(this.data.pageCount-1,this.data.page+Number(e.currentTarget.dataset.delta)))});this.updatePage();},
  titleInput(e){this.setData({title:e.detail.value});},
  rename(){run(this,async()=>{await api.request(`/activities/${activity()}/jiaozi`,'PATCH',{title:this.data.title});await this.load();});},
  nav(e){go(e.currentTarget.dataset.page);},
  export(){run(this,async()=>{await this.load();const path=await card.exportPage(this,this.data.overview,this.data.page);this.setData({exportPath:path});wx.previewImage({urls:[path]});});},
  save(){wx.saveImageToPhotosAlbum({filePath:this.data.exportPath,success:()=>wx.showToast({title:'已保存'}),fail:()=>wx.showModal({title:'需要相册权限',content:'请在设置中允许保存纪念图',success:r=>{if(r.confirm)wx.openSetting({});}})});},
  leave(){api.host.leave();}
});
