const { PLACES, planTrail, stampPlace, walletState } = require('../../utils/trail');

Page({
  data: {
    activeTab: 'explore',
    interests: [
      { name: '美妆首发', selected: true },
      { name: '咖啡甜点', selected: true },
      { name: '城市好物', selected: true }
    ],
    budgets: [150, 300, 500],
    durations: [{ value: 120, label: '2 小时' }, { value: 240, label: '4 小时' }, { value: 360, label: '慢慢逛' }],
    budget: 300,
    duration: 240,
    wish: '',
    route: null,
    stamps: [],
    wallet: walletState([]),
    recommendations: PLACES.slice(0, 3)
  },

  toggleInterest(event) {
    const name = event.currentTarget.dataset.name;
    this.setData({ interests: this.data.interests.map((item) => ({ name: item.name, selected: item.name === name ? !item.selected : item.selected })) });
  },

  selectBudget(event) {
    this.setData({ budget: Number(event.currentTarget.dataset.value) });
  },

  selectDuration(event) {
    this.setData({ duration: Number(event.currentTarget.dataset.value) });
  },

  updateWish(event) {
    this.setData({ wish: event.detail.value });
  },

  generateRoute() {
    const interests = this.data.interests.filter((item) => item.selected).map((item) => item.name);
    const wish = this.data.wish.trim();
    // 页面测试版使用关键词匹配；后续由后端接入模型做需求解析。
    if (/咖啡|甜点|brunch/i.test(wish) && interests.indexOf('咖啡甜点') === -1) interests.push('咖啡甜点');
    if (/美妆|小样/.test(wish) && interests.indexOf('美妆首发') === -1) interests.push('美妆首发');
    if (/书|文创|好物/.test(wish) && interests.indexOf('城市好物') === -1) interests.push('城市好物');
    const route = planTrail({ budget: this.data.budget, duration: this.data.duration, interests });
    if (!route) {
      wx.showToast({ title: '试试增加一点预算或时间', icon: 'none' });
      return;
    }
    route.stops = route.stops.map((stop) => Object.assign({}, stop, { checked: this.data.stamps.indexOf(stop.id) !== -1 }));
    this.setData({ route }, () => {
      wx.pageScrollTo({ selector: '#route-section', duration: 300 });
    });
    wx.showToast({ title: '你的路线已生成', icon: 'success' });
  },

  checkIn(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.route || !this.data.route.stops.some((stop) => stop.id === id)) return;
    const stamps = stampPlace(this.data.stamps, id);
    if (stamps.length === this.data.stamps.length) return;
    const route = Object.assign({}, this.data.route, {
      stops: this.data.route.stops.map((stop) => Object.assign({}, stop, { checked: stamps.indexOf(stop.id) !== -1 }))
    });
    this.setData({ stamps, route, wallet: walletState(stamps) });
    wx.showToast({ title: '足迹已收集', icon: 'success' });
  },

  changeTab(event) {
    this.setData({ activeTab: event.currentTarget.dataset.tab }, () => wx.pageScrollTo({ scrollTop: 0, duration: 0 }));
  },

  showDetails(event) {
    const place = PLACES.find((item) => item.id === event.currentTarget.dataset.id);
    if (!place) return;
    wx.showModal({ title: place.name, content: `${place.description}。演示人均预算 ¥${place.cost}，预计排队 ${place.queue} 分钟。${place.perk}仅用于演示，不可实际兑换。`, showCancel: false, confirmText: '了解了', confirmColor: '#234b3d' });
  }
});
