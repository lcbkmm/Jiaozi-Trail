const seed = require('../../data/preview.js');
const API_STORAGE = 'jiaozi-api-base';
const SESSION_STORAGE = 'jiaozi-mini-session';
const CHAT_API_REVISION = 'jiaozi-chat-api-demo-v3';
const DEMO_START = '2026-11-01T14:00:00+08:00';
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
    detail: null, chatText: '', chatMessages: [], chatLoading: false, chatPending: null, chatNotice: '',
    actionLoading: false, positionLabel: '使用已选起点', positionMode: 'planned_start',
    effectiveAt: '', completedCount: 0, dynamicNotice: '', pendingIndex: 0
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
        timeout: path.indexOf('/chat') >= 0 ? 45000 : 30000,
        header: { 'Content-Type': 'application/json', 'X-Demo-Session': self.sessionToken || '' },
        success: function(response) {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data);
          else {
            const info = response.data && response.data.error;
            const error = new Error(info ? info.message : '后端请求失败');
            error.code = info && info.code; reject(error);
          }
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
      const session = await this.request('/api/v1/demo/sessions', 'POST', { business_now: DEMO_START });
      this.sessionToken = session.data.session_token;
      wx.setStorageSync(SESSION_STORAGE, this.sessionToken);
      wx.setStorageSync(API_STORAGE, this.data.apiBase);
      wx.setStorageSync(CHAT_API_REVISION, true);
      this.chatRevision = 0; this.chatPreferences = null; this.savedRoute = null;
      this.businessNow = session.data.business_now; this.currentPosition = null; this.selectedPlaceId = null;
      this.setData({ chatMessages: [], chatPending: null, chatNotice: '', routeStatus: 'planned',
        effectiveAt: this.businessNow, positionMode: 'planned_start', positionLabel: '使用已选起点', completedCount: 0, dynamicNotice: '' });
      const places = await this.request('/api/v1/places');
      this.places = places.data;
      this.showOptions(seed.options);
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
      start_place_id: (this.places.some(function(p) { return p.place_id === 'chunxi_start'; }) ? 'chunxi_start' : this.places[0].place_id),
      departure_at: this.businessNow || '2026-10-31T14:00:00+08:00',
      use_current_position: this.data.positionMode === 'current_position',
      max_duration_s: this.data.durationValues[this.data.durationIndex] * 60,
      budget_per_person_fen: Math.round(Number(this.data.budget) * 100),
      max_walk_m: this.data.route ? this.data.route.preferences.max_walk_m : 3000,
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
      if (this.savedRoute && this.savedRoute.status === 'active') {
        await this.proposeRemaining({max_duration_s: preferences.max_duration_s, budget_per_person_fen: preferences.budget_per_person_fen, interests: preferences.interests}, '调整表单条件');
        return;
      }
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
  chooseOption: function(event) {
    if (this.savedRoute && ['active','completed'].indexOf(this.savedRoute.status) >= 0) return;
    this.displayOption(event.currentTarget.dataset.id);
  },
  displayOption: function(id) {
    const route = this.data.options.find(function(option) { return option.option_id === id; });
    if (!route) return;
    this.savedRoute = null;
    this.renderRoute(route, 'planned');
  },
  renderRoute: function(plan, status) {
    const completed = (plan.progress && plan.progress.completed_place_ids) || [];
    const route = decorate(plan);
    route.stops = route.stops.map(function(stop) { return Object.assign({}, stop, { completed: completed.indexOf(stop.place_id) >= 0 }); });
    const polylines = route.legs.filter(function(leg) { return leg.points.length > 1; }).map(function(leg) {
      return { points: leg.points, color: '#477349', width: 5, arrowLine: true };
    });
    const includePoints = [];
    route.legs.forEach(function(leg) { includePoints.push.apply(includePoints, leg.points); });
    const places = this.places;
    const markers = route.stops.map(function(stop, index) {
      const place = places.find(function(p) { return p.place_id === stop.place_id; });
      const leg = route.legs.find(function(item) { return item.to_place_id === stop.place_id; });
      const point = place || (leg && leg.points[leg.points.length - 1]);
      if (!point) return null;
      return { id: index, latitude: point.latitude, longitude: point.longitude,
        iconPath: '/assets/marker.png', width: 26, height: 26,
        callout: { content: String(index + 1) + ' · ' + stop.name + (stop.completed ? '（已完成）' : ''), display: 'BYCLICK', padding: 6, borderRadius: 6 } };
    }).filter(Boolean);
    this.setData({ selectedId: plan.option_id || 'balanced', route: route, routeStatus: status,
      markers: markers, polylines: polylines, includePoints: includePoints, completedCount: completed.length });
  },
  renderSavedRoute: function(route) {
    this.savedRoute = route;
    this.chatPreferences = route.preferences;
    this.syncPreferenceControls(route.preferences);
    this.renderRoute(Object.assign({option_id: 'saved', title: '当前行程'}, route), route.status);
    this.setData({ options: [], chatPending: null });
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
      if (this.savedRoute) {
        payload.route_id=this.savedRoute.route_id; payload.base_revision=this.savedRoute.revision;
        payload.effective_at=this.businessNow || this.savedRoute.departure_at;
        payload.replan_origin=this.data.positionMode === 'last_completed' ? 'last_completed' : 'current_position';
      }
      const response = await this.request('/api/v1/chat','POST',payload);
      const result = response.data;
      this.chatRevision = result.context_revision;
      this.chatPreferences = result.preferences;
      const newMessages = this.data.chatMessages.concat([{id:'a'+Date.now(),role:'assistant',text:result.reply}]);
      const pending = result.status==='proposal' ? this.decoratePending(result) : null;
      this.setData({ chatMessages:newMessages.slice(-12), chatText:'', chatPending:pending, pendingIndex:0,
        chatNotice:result.status==='proposal' ? '新方案尚未替换当前页面，确认后应用。' : '' });
    } catch (error) {
      await this.recoverConflict(error);
      this.setData({chatNotice:error.message+' 原路线和表单仍可使用，未执行本次修改。'});
    } finally { this.setData({ chatLoading:false }); }
  },
  applyChatProposal: async function() {
    const pending=this.data.chatPending;
    if (!pending || this.data.actionLoading) return;
    if (pending.replan_proposals && pending.replan_proposals.length) {
      this.setData({actionLoading:true});
      try {
        const proposal=pending.replan_proposals[this.data.pendingIndex || 0];
        const accepted=(await this.request('/api/v1/routes/'+this.savedRoute.route_id+'/accept','POST', {
          base_revision:proposal.base_revision, proposal_id:proposal.proposal_id})).data;
        this.renderSavedRoute(accepted);
        this.setData({chatNotice:accepted.status === 'completed' ? '行程已完成。' : '已确认新方案，剩余路线已更新；已完成地点保留。'});
      } catch(error) { await this.recoverConflict(error); this.setData({chatNotice:error.message}); }
      finally {this.setData({actionLoading:false});}
      return;
    }
    this.syncPreferenceControls(pending.preferences);
    this.setData({chatPending:null, chatNotice:'已应用建议条件。路线尚未开始，点击保存并开始才写入行程。'});
    this.showOptions(pending.route_options);
  },
  dismissChatProposal: function() {
    this.chatPreferences = this.preferences();
    this.setData({chatPending:null, chatNotice:'当前路线未改变。'});
  },

  syncPreferenceControls: function(pref) {
    const minutes=pref.max_duration_s/60;
    const durations=this.data.durationValues.slice(),labels=this.data.durationLabels.slice();
    if (durations.indexOf(minutes)<0) {durations.push(minutes);labels.push(minutes+' 分钟');}
    this.setData({budget:String(pref.budget_per_person_fen/100),durationValues:durations,durationLabels:labels,
      durationIndex:durations.indexOf(minutes),interestTags:this.data.interestTags.map(function(tag){
        return Object.assign({},tag,{selected:pref.interests.indexOf(tag.id)>=0});})});
  },
  decoratePending: function(result) {
    const self=this;
    const pending=Object.assign({},result, {summary:'预算 ¥'+(result.preferences.budget_per_person_fen/100)+' / '+Math.round(result.preferences.max_duration_s/60)+' 分钟'});
    pending.choices=(result.replan_proposals || []).map(function(proposal,index) {
      const names=function(ids) { return ids.map(function(id) { const p=self.places.find(function(p) {return p.place_id===id;});return p ? p.name : id; }).join('、') || '无'; };
      const delta=Math.round(proposal.diff.remaining_duration_delta_s/60);
      return {index:index,title:proposal.title, summary:'替换：'+names(proposal.diff.removed_place_ids)+' → '+names(proposal.diff.added_place_ids),
        detail:'剩余约 '+Math.ceil(proposal.route.remaining_totals.duration_s/60)+' 分钟 / '+(proposal.route.remaining_totals.walk_distance_m/1000).toFixed(2)+' km；时间变化 '+(delta>0?'+':'')+delta+' 分钟'};
    });
    return pending;
  },
  choosePending: function(event) {this.setData({pendingIndex:Number(event.currentTarget.dataset.index)});},
  recoverConflict: async function(error) {
    if (['STALE_REVISION','STALE_PROPOSAL','STALE_CONTEXT','STALE_POSITION'].indexOf(error.code)<0) return;
    this.setData({chatPending:null});
    if (this.savedRoute) {
      try {this.renderSavedRoute((await this.request('/api/v1/routes/'+this.savedRoute.route_id)).data);} catch(ignored) {}
    }
    try {const chat=(await this.request('/api/v1/chat')).data;this.chatRevision=chat.revision;} catch(ignored) {}
  },
  uploadPosition: async function(point,source) {
    const position={longitude:point.longitude,latitude:point.latitude,coord_system:'gcj02',
      accuracy_m:point.accuracy || 5, observed_at:new Date().toISOString(),source:source,confirmed:source==='demo'};
    const response=await this.request('/api/v1/position','PUT',position);
    this.currentPosition=response.data.position;
    this.setData({positionMode:'current_position',positionLabel:source==='demo'?'已确认演示位置':'已更新设备位置',chatPending:null});
  },
  locateUser: async function() {
    if (!this.data.online || this.data.actionLoading) return;
    this.setData({actionLoading:true});
    try {
      const point=await new Promise(function(resolve,reject) {wx.getLocation({type:'gcj02',success:resolve,fail:function(){reject(new Error('未取得设备位置。可确认商圈内的演示位置。'));}});});
      await this.uploadPosition(point,'device');
      this.setData({dynamicNotice:'定位已更新；生成或重排时将从这里出发。'});
    } catch(error) {this.setData({dynamicNotice:error.message});}
    finally {this.setData({actionLoading:false});}
  },
  confirmDemoPosition: function() {
    if (!this.data.online || this.data.actionLoading) return;
    const completed=this.savedRoute && this.savedRoute.progress && this.savedRoute.progress.completed_place_ids;
    const placeId=completed && completed.length ? completed[completed.length-1] : this.preferences().start_place_id;
    const point=this.places.find(function(p){return p.place_id===placeId;});
    if (!point) return;
    const self=this;
    wx.showModal({title:'确认演示位置',content:'将位置设为“'+point.name+'”。这是演示坐标，并非设备实测位置。',success:async function(answer){
      if (!answer.confirm) return;
      self.setData({actionLoading:true});
      try {await self.uploadPosition(point,'demo');self.setData({dynamicNotice:'演示位置已设为 '+point.name});}
      catch(error){self.setData({dynamicNotice:error.message});}
      finally {self.setData({actionLoading:false});}
    }});
  },
  completeNextStop: async function() {
    if (!this.savedRoute || this.savedRoute.status!=='active' || this.data.actionLoading) return;
    const route=this.savedRoute;
    const completed=(route.progress && route.progress.completed_place_ids) || [];
    const next=route.stops[completed.length];
    if (!next) {await this.proposeRemaining({},'所有站点已完成');return;}
    this.setData({actionLoading:true});
    try {
      const when=new Date(Math.max(Date.parse(this.businessNow || route.departure_at),Date.parse(next.departure_at))).toISOString();
      const updated=(await this.request('/api/v1/routes/'+route.route_id+'/progress','POST',{
        base_revision:route.revision,completed_place_ids:completed.concat([next.place_id]),effective_at:when,source:'demo'})).data;
      this.businessNow=when;
      this.renderSavedRoute(updated);
      this.setData({effectiveAt:when,positionMode:'last_completed',positionLabel:'从已确认完成的 '+next.name+' 出发',
        dynamicNotice:'演示进度已推进到 '+next.name+'；非设备到店核验。'});
    } catch(error) {await this.recoverConflict(error);this.setData({dynamicNotice:error.message});}
    finally {this.setData({actionLoading:false});}
  },
  simulateQueue: async function() {
    if (!this.savedRoute || this.savedRoute.status!=='active' || this.data.actionLoading) return;
    const route=this.savedRoute;
    const completed=(route.progress && route.progress.completed_place_ids) || [];
    const remaining=route.stops.filter(function(s){return completed.indexOf(s.place_id)<0;});
    const target=remaining.find(function(s){return s.category==='meal';}) || remaining[0];
    if (!target) {this.setData({dynamicNotice:'全部站点已完成，可结束行程。'});return;}
    this.setData({actionLoading:true,chatPending:null});
    try {
      const state=(await this.request('/api/v1/dynamic-state')).data;
      await this.request('/api/v1/demo/events','POST',{place_id:target.place_id,base_state_version:state.state_version,queue_s:2400,source:'demo'});
      const assessment=(await this.request('/api/v1/routes/'+route.route_id+'/assessment')).data;
      this.selectedPlaceId=target.place_id;
      this.setData({dynamicNotice:'已模拟 '+target.name+' 排队 40 分钟。'+assessment.reasons.map(function(r){return r.message;}).join('；')+'；可点击重排或说“换一家，少走一点”。'});
    } catch(error) {this.setData({dynamicNotice:error.message});}
    finally {this.setData({actionLoading:false});}
  },
  proposeRemaining: async function(patch,reason) {
    if (!this.savedRoute || this.savedRoute.status!=='active') return;
    const route=this.savedRoute;
    const data=(await this.request('/api/v1/routes/'+route.route_id+'/replan','POST',{
      base_revision:route.revision,effective_at:this.businessNow || route.departure_at,
      origin:this.data.positionMode==='last_completed'?'last_completed':'current_position',preference_patch:patch || {},reason:reason || '检查动态变化'})).data;
    this.setData({chatPending:this.decoratePending({preferences:Object.assign({},route.preferences,patch),
      replan_proposals:data.proposals,route_options:data.proposals.map(function(p){return p.route;})}),pendingIndex:0,
      chatNotice:'已计算剩余方案，选择并确认后更新；当前路线保留。'});
  },
  replanNow: async function() {
    if (this.data.actionLoading) return;
    this.setData({actionLoading:true});
    try {await this.proposeRemaining({},'动态状态变化');}
    catch(error){await this.recoverConflict(error);this.setData({dynamicNotice:error.message});}
    finally {this.setData({actionLoading:false});}
  },

  startRoute: async function() {
    if (['active','completed'].indexOf(this.data.routeStatus) >= 0 || this.data.saving || !this.data.route) return;
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
      this.businessNow=started.departure_at;
      this.renderSavedRoute(started);
      wx.setStorageSync(SAVED_ROUTE_STORAGE, started.route_id);
      this.setData({ routeStatus: 'active' });
      wx.showToast({ title: '已保存并开始', icon: 'success' });
    } catch (error) { wx.showModal({ title: '尚未开始', content: error.message, showCancel: false }); }
    finally { this.setData({ saving: false }); }
  }
});
