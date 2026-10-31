Page({
  enter(e) {wx.navigateTo({url:'/packages/digital-jiaozi/pages/home/index?demoAccount='+e.currentTarget.dataset.account});},
  staff(){wx.navigateTo({url:'/packages/digital-jiaozi/pages/staff/index'});}
});
