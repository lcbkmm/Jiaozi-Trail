const seed = require('../../data/preview.js');
const API_STORAGE = 'jiaozi-api-base';
const SESSION_STORAGE = 'jiaozi-mini-session';
const CHAT_API_REVISION = 'jiaozi-chat-api-2a-deepseek';
const SAVED_ROUTE_STORAGE = 'jiaozi-mini-last-route';

function decorate(plan) {
  return Object.assign({}, plan, {
    walkKm: (plan.totals.walk_distance_m / 1000).toFixed(2),
    durationMinutes: Math.ceil(plan.totals.duration_s / 60),
    costMin: Math.round(plan.totals.cost_min_per_person_fen / 100),
    costMax: Math.round(plan.totals.cost_max_per_person_fen / 100),
    stops: plan.stops.map(function(stop) {
      return Object.assign({}, stop, {
        arrivalLabel: stop.arrival_at.slice(11, 16),
        walkMinutes: Math.ceil(stop.walk_duration_s / 60),
        queueMinutes: Math.ceil(stop.queue_duration_s / 60),
        dwellMinutes: Math.ceil(stop.dwell_duration_s / 60)
      });
    })
  });
}

Page({
  data: {
    apiBase: 'http://127.0.0.1:8004', online: false, connecting: false,
    loading: false, saving: false, durationLabels: ['90 分钟', '120 分钟', '180 分钟', '240 分钟'],
    durationValues: [90, 120, 180, 240], durationIndex: 2, budget: '200',
    interestTags: [
      { id: 'coffee', label: '咖啡', selected: true },
      { id: 'food', label: '美食', selected: true },
      { id: 'landmark', label: '地标', selected: true },
      { id: 'launch', label: '首发', selected: false },
      { id: 'culture', label: '文化', selected: false },
      { id: 'lifestyle', label: '逛店', selected: false }
    ],
    options: [], selectedId: '', route: null, routeStatus: 'planned',
    markers: [], polylines: [], includePoints: [], mapLatitude: 30.6548, mapLongitude: 104.0815,
    detail: null, chatText: '', chatMessages: [], chatLoading: false, chatPending: null, chatNotice: ''
  },

  onLoad: function() {
    this.places = seed.places;
    this.details = seed.details;
    this.sessionToken = wx.getStorageSync(SESSION_STORAGE) || '';
    this.setData({ apiBase: wx.getStorageSync(CHAT_API_REVISION) ? (wx.getStorageSync(API_STORAGE) || getApp().globalData.apiBase) : getApp().globalData.apiBase });
    this.showOptions(seed.options);
  },

  onDuration: function(event) { this.setData({ durationIndex: Number(event.detail.value) }); },
  onBudget: function(event) { this.setData({ budget: event.detail.value }); },
  onApiInput: function(event) { this.setData({ apiBase: event.detail.value.trim() }); },
  onInterest: function(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ interestTags: this.data.interestTags.map(function(tag) {
      return Object.assign({}, tag, { selected: tag.id === id ? !tag.selected : tag.selected });
    }) });
  },
  noop: function() {},
  closeDetail: function() { this.setData({ detail: null }); },

  request: function(path, method, body) {
    const self = this;
    return new Promise(function(resolve, reject) {
      wx.request({
        url: self.data.apiBase.replace(/\/$/, '') + path,
        method: method || 'GET', data: body,
        timeout: path.indexOf('/chat') >= 0 ? 45000 : 20000,
        header: { 'Content-Type': 'application/json', 'X-Demo-Session': self.sessionToken || '' },
        success: function(response) {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data);
          else reject(new Error(response.data && response.data.error ? response.data.error.message : '后端请求失败'));
        },
        fail: function() { reject(new Error('无法连接后端。检查服务地址及开发工具本地请求设置；当前预览仍可使用。')); }
      });
    });
  },

  connect: async function() {
    if (this.data.connecting) return;
    if (!/^https?:\/\//.test(this.data.apiBase)) {
      wx.showToast({ title: '请输入 http 或 https 地址', icon: 'none' }); return;
    }
    this.setData({ connecting: true });
    try {
      await this.request('/health');
      const session = await this.request('/api/v1/demo/sessions', 'POST', {});
      this.sessionToken = session.data.session_token;
      wx.setStorageSync(SESSION_STORAGE, this.sessionToken);
      wx.setStorageSync(API_STORAGE, this.data.apiBase);
      wx.setStorageSync(CHAT_API_REVISION, true);
      this.chatRevision = 0; this.chatPreferences = null;
      this.setData({ chatMessages: [], chatPending: null, chatNotice: '' });
      const places = await this.request('/api/v1/places');
      this.places = places.data;
      this.setData({ online: true });
      await this.generate();
    } catch (error) {
      this.setData({ online: false });
      this.showOptions(seed.options);
      wx.showModal({ title: '继续使用预览', content: error.message, showCancel: false });
    } finally { this.setData({ connecting: false }); }
  },

  preferences: function() {
    return Object.assign({}, (this.data.route && this.data.route.preferences) || {}, {
      start_place_id: 'chunxi_start', departure_at: '2026-10-31T14:00:00+08:00',
      max_duration_s: this.data.durationValues[this.data.durationIndex] * 60,
      budget_per_person_fen: Math.round(Number(this.data.budget) * 100),
      max_walk_m: (this.data.route && this.data.route.preferences.max_walk_m) || 3000,
      interests: this.data.interestTags.filter(function(tag) { return tag.selected; }).map(function(tag) { return tag.id; })
    });
  },

  generate: async function() {
    if (this.data.loading) return;
    const preferences = this.preferences();
    if (this.data.budget === '' || !Number.isFinite(preferences.budget_per_person_fen) || preferences.budget_per_person_fen < 0 || preferences.budget_per_person_fen > 1000000) {
      wx.showToast({ title: '请填写有效预算', icon: 'none' }); return;
    }
    if (!this.data.online) {
      const original = seed.options[0].preferences;
      const same = preferences.max_duration_s === original.max_duration_s && preferences.budget_per_person_fen === original.budget_per_person_fen && preferences.interests.slice().sort().join(',') === original.interests.slice().sort().join(',');
      if (!same) {
        wx.showModal({ title: '需要连接后端', content: '预览包仅有默认条件的真实路段方案，修改条件后需要连接后端重新计算。下面保留默认方案供查看。', showCancel: false });
        return;
      }
      this.showOptions(seed.options);
      wx.showToast({ title: '已加载准备好的方案', icon: 'none' }); return;
    }
    this.setData({ loading: true });
    try {
      const response = await this.request('/api/v1/route-options', 'POST', preferences);
      this.chatPreferences = null; this.setData({ chatPending: null });
      this.showOptions(response.data.options);
    } catch (error) {
      wx.showModal({ title: '未生成新路线', content: error.message, showCancel: false });
    } finally { this.setData({ loading: false }); }
  },

  showOptions: function(options) {
    this.setData({ options: options.map(decorate), routeStatus: 'planned' });
    if (options.length) this.displayOption(options[0].option_id);
    else this.setData({ route: null, selectedId: '' });
  },
  chooseOption: function(event) { this.displayOption(event.currentTarget.dataset.id); },
  displayOption: function(id) {
    const route = this.data.options.find(function(option) { return option.option_id === id; });
    if (!route) return;
    this.savedRoute = null;
    const polylines = route.legs.filter(function(leg) { return leg.points.length > 1; }).map(function(leg) {
      return { points: leg.points, color: '#477349', width: 5, arrowLine: true };
    });
    const includePoints = [];
    route.legs.forEach(function(leg) { includePoints.push.apply(includePoints, leg.points); });
    const markers = route.stops.map(function(stop, index) {
      const leg = route.legs[index];
      const point = leg.points[leg.points.length - 1];
      return { id: index, latitude: point.latitude, longitude: point.longitude,
        iconPath: '/assets/marker.png', width: 26, height: 26,
        callout: { content: String(index + 1) + ' · ' + stop.name, display: 'BYCLICK', padding: 6, borderRadius: 6 } };
    });
    this.setData({ selectedId: id, route: route, routeStatus: 'planned', markers: markers,
      polylines: polylines, includePoints: includePoints });
  },

  onMarkerTap: function(event) {
    const stop = this.data.route.stops[event.detail.markerId];
    if (stop) this.openPlace(stop.place_id);
  },
  showPlace: function(event) { this.openPlace(event.currentTarget.dataset.placeId); },
  openPlace: async function(placeId) {
    this.selectedPlaceId = placeId;
    try {
      let detail = this.details[placeId];
      if (this.data.online) detail = (await this.request('/api/v1/places/' + encodeURIComponent(placeId))).data;
      if (!detail) return;
      this.setData({ detail: Object.assign({}, detail, {
        queueLabel: detail.queue.duration_s === null ? '未知' : Math.ceil(detail.queue.duration_s / 60) + ' 分钟（演示）',
        statusLabel: detail.opening_status.value === 'open' ? '开放（演示配置）' : '未知或关闭'
      }) });
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); }
  },

  onChatInput: function(event) { this.setData({ chatText: event.detail.value }); },
  useChatExample: function(event) { this.setData({ chatText: event.currentTarget.dataset.text }); },
  sendChat: async function() {
    if (this.data.chatLoading) return;
    const text = this.data.chatText.trim();
    if (!text) { wx.showToast({title:'先输入想说的话',icon:'none'}); return; }
    if (!this.data.online) { wx.showToast({title:'请在页面底部连接后端',icon:'none'}); return; }
    const messages = this.data.chatMessages.concat([{ id:'u'+Date.now(), role:'user', text:text }]);
    this.setData({ chatMessages: messages.slice(-12), chatLoading:true, chatNotice:'', chatPending:null });
    try {
      const payload = { text:text, current_preferences:this.chatPreferences || this.preferences(),
        context_revision:this.chatRevision || 0, selected_place_id:this.selectedPlaceId || null };
      if (this.savedRoute) { payload.route_id=this.savedRoute.route_id; payload.base_revision=this.savedRoute.revision; }
      const response = await this.request('/api/v1/chat','POST',payload);
      const result = response.data;
      this.chatRevision = result.context_revision;
      this.chatPreferences = result.preferences;
      const newMessages = this.data.chatMessages.concat([{id:'a'+Date.now(),role:'assistant',text:result.reply}]);
      const pending = result.status==='proposal' ? Object.assign({},result, {summary:'预算 ¥'+(result.preferences.budget_per_person_fen/100)+' / '+Math.round(result.preferences.max_duration_s/60)+' 分钟；保留 '+result.preferences.must_visit_ids.length+' 个必去点'}) : null;
      this.setData({ chatMessages:newMessages.slice(-12), chatText:'', chatPending:pending,
        chatNotice:result.status==='proposal' ? '新方案尚未替换当前页面，确认后应用。' : '' });
    } catch (error) {
      this.setData({chatNotice:error.message+' 原路线和表单仍可使用，未执行本次修改。'});
    } finally { this.setData({ chatLoading:false }); }
  },
  applyChatProposal: function() {
    const pending=this.data.chatPending;
    if (!pending) return;
    const pref=pending.preferences;
    const minutes=pref.max_duration_s/60;
    const durations=this.data.durationValues.slice();
    const labels=this.data.durationLabels.slice();
    if (durations.indexOf(minutes)<0) {durations.push(minutes);labels.push(minutes+' 分钟');}
    this.setData({ budget:String(pref.budget_per_person_fen/100), durationValues:durations,
      durationLabels:labels, durationIndex:durations.indexOf(minutes),
      interestTags:this.data.interestTags.map(function(tag){return Object.assign({},tag,{selected:pref.interests.indexOf(tag.id)>=0});}),
      chatPending:null, chatNotice:'已应用建议条件。路线尚未开始，点击保存并开始才写入行程。' });
    this.showOptions(pending.route_options);
  },
  dismissChatProposal: function() {
    this.chatPreferences = this.preferences();
    this.setData({chatPending:null, chatNotice:'当前路线未改变。'});
  },

  startRoute: async function() {
    if (this.data.routeStatus === 'active' || this.data.saving || !this.data.route) return;
    if (!this.data.online) {
      this.setData({ routeStatus: 'active' });
      wx.showToast({ title: '演示开始，未写入后端', icon: 'none' }); return;
    }
    this.setData({ saving: true });
    try {
      if (!this.savedRoute) {
        this.savedRoute = (await this.request('/api/v1/routes', 'POST', this.data.route.preferences)).data;
      }
      const started = (await this.request('/api/v1/routes/' + this.savedRoute.route_id + '/start', 'POST', { base_revision: this.savedRoute.revision })).data;
      this.savedRoute = started;
      wx.setStorageSync(SAVED_ROUTE_STORAGE, started.route_id);
      this.setData({ routeStatus: 'active' });
      wx.showToast({ title: '已保存并开始', icon: 'success' });
    } catch (error) { wx.showModal({ title: '尚未开始', content: error.message, showCancel: false }); }
    finally { this.setData({ saving: false }); }
  }
});
