const {api,activity,run,time}=require('../../services/page');
const labels={initialize:'首次领取',daily:'每日签到','checkin.verified':'有效地点','purchase.verified':'有效消费','culture_task.completed':'文化体验','route.completed':'路线完成',redemption:'兑换扣减',CANCELLED:'取消退款',EXPIRED:'到期退款'};
Page({data:{busy:false,error:'',items:[],cursor:null,kind:'',overview:null},onLoad(){run(this,async()=>{const r=await api.request(`/activities/${activity()}/overview`);this.setData({overview:r.data});await this.load(true);});},
  async load(reset){const cursor=reset?null:this.data.cursor;const r=await api.request(`/activities/${activity()}/points/ledger?limit=20${cursor?'&cursor='+cursor:''}${this.data.kind?'&kind='+this.data.kind:''}`);const items=r.data.items.map(i=>({...i,label:labels[i.sourceType]||i.sourceType,time:time(i.createdAt)}));this.setData({items:reset?items:this.data.items.concat(items),cursor:r.data.nextCursor});},
  filter(e){this.setData({kind:e.currentTarget.dataset.kind});run(this,()=>this.load(true));},more(){run(this,()=>this.load(false));}
});
