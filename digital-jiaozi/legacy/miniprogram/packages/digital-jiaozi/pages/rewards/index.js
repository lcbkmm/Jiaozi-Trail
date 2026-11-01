const {api,activity,run,confirm,go}=require('../../services/page');
Page({data:{busy:false,error:'',items:[],overview:null},onShow(){run(this,()=>this.load());},async load(){const r=await api.request(`/activities/${activity()}/rewards`),o=await api.request(`/activities/${activity()}/overview`);this.setData({items:r.data,overview:o.data});},
  redeem(e){const item=this.data.items.find(i=>i.id===e.currentTarget.dataset.id);run(this,async()=>{if(!await confirm(`使用 ${item.cost} 可用积分兑换${item.title}？15分钟内到 ${item.pointId} 领取，未领取可取消退款。`))return;this.keys=this.keys||{};const r=await api.request(`/activities/${activity()}/redemptions`,'POST',{rewardItemId:item.id},{key:this.keys[item.id]||(this.keys[item.id]=api.key())});delete this.keys[item.id];wx.navigateTo({url:`/packages/digital-jiaozi/pages/order/index?id=${r.data.id}`});});},
  orders(){go('orders');},refresh(){run(this,()=>this.load());}
});
