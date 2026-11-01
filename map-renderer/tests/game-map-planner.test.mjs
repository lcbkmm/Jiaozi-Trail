import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlannerClient, parseRuleIntent, preferencesForOption, preferencesFromFields, routeSnapshot, setupMapPlanner } from '../game-map-planner.mjs';

const fields = { start: 'chunxi_start', end: 'ifs', departure: '2026-10-31T14:00', duration: 180, budget: 150.25, buffer: 8, walk: 3000, queue: 15,
  interests: ['coffee', 'landmark'], excludedInterests: ['hotpot'], required: ['ifs'], excluded: ['tea'], style: 'less_walking', usePosition: true };
const preferences = preferencesFromFields(fields);
const places = [
  { place_id: 'chunxi_start', name: '春熙路站', category: 'start', longitude: 104.077, latitude: 30.653, address: '地铁站', coord_system: 'gcj02' },
  { place_id: 'ifs', name: '成都 IFS', category: 'landmark', longitude: 104.078, latitude: 30.655, address: '红星路', coord_system: 'gcj02', retrieved_at: '2026-10-31T00:00:00Z' },
  { place_id: 'tea', name: '测试茶店', category: 'tea', longitude: 104.0775, latitude: 30.654, address: '春熙路', coord_system: 'gcj02' }
];
const option = { option_id: 'balanced', title: '综合推荐', preferences: { ...preferences, use_current_position: false, planning_style: 'balanced' }, departure_at: '2026-10-31T14:00:00+08:00', planned_end_at: '2026-10-31T15:00:00+08:00',
  stops: [{ place_id: 'ifs', name: '成都 IFS', activity_title: '地标漫游', arrival_at: '2026-10-31T14:10:00+08:00', departure_at: '2026-10-31T14:40:00+08:00', walk_duration_s: 600, queue_duration_s: 60, dwell_duration_s: 1200, benefits: [] }],
  legs: [{ from_place_id: 'chunxi_start', to_place_id: 'ifs', coord_system: 'gcj02', source: 'baidu_walking', delivery: 'cached', points: places.slice(0, 2) }],
  totals: { duration_s: 3600, walk_distance_m: 200, cost_min_per_person_fen: 0, cost_max_per_person_fen: 3000 }, warnings: [], sources: { path: 'baidu_walking', campaign: 'demo' } };
const copy = value => JSON.parse(JSON.stringify(value));
const response = (data, status = 200, raw = false) => ({ ok: status >= 200 && status < 300, status, json: async () => raw ? data : { data } });
function memory(initial = {}) { const m = new Map(Object.entries(initial)); return { getItem: key => m.get(key) ?? null, setItem: (key, value) => m.set(key, value), removeItem: key => m.delete(key), m }; }

test('full preference form preserves every constraint, currency units and timezone', () => {
  assert.equal(preferences.budget_per_person_fen, 15025); assert.equal(preferences.max_duration_s, 10800); assert.equal(preferences.buffer_s, 480);
  assert.equal(preferences.max_queue_s, 900); assert.equal(preferences.departure_at, '2026-10-31T14:00:00+08:00');
  assert.deepEqual(preferences.must_visit_ids, ['ifs']); assert.deepEqual(preferences.excluded_place_ids, ['tea']); assert.deepEqual(preferences.excluded_interests, ['hotpot']);
  assert.equal(preferences.use_current_position, true); assert.equal(preferences.end_place_id, 'ifs');
  assert.throws(() => preferencesFromFields({ ...fields, excluded: ['ifs'] }), /同时/);
  assert.throws(() => preferencesFromFields({ ...fields, budget: -1 }), /预算/);
  assert.throws(() => preferencesFromFields({ ...fields, departure: 'tomorrow' }), /北京/);
});

test('API client unwraps data, persists only the session token, and prefixes the fixed same-origin bridge', async () => {
  const calls = [], storage = memory();
  const host = { localStorage: storage, fetch: async (url, config) => { calls.push({ url, config }); return url.endsWith('sessions') ? response({ session_token: 'opaque', participant_id: 'demo_x' }) : url.endsWith('/health') ? response({ status: 'ok' }, 200, true) : response(places); } };
  const c = createPlannerClient({ host }); assert.equal(c.hasSession(), false); await c.health(); await c.createSession();
  assert.deepEqual(await c.request('/places'), places); assert.equal(storage.getItem('jiaozi-demo-session'), 'opaque');
  assert.equal(calls[0].url, '/planning/health'); assert.equal(calls[2].url, '/planning/api/v1/places');
  assert.equal(calls[2].config.headers['X-Demo-Session'], 'opaque'); assert.equal(calls[1].config.headers['X-Demo-Session'], undefined);
  assert.equal(calls[2].config.credentials, 'same-origin'); await assert.rejects(c.request('//outside.example'), /无效/);
});

test('expired sessions, conflicts and uncertain mutations are surfaced without creating sessions or replaying writes', async () => {
  for (const status of [401, 409]) {
    const calls = [], host = { localStorage: memory({ 'jiaozi-demo-session': 'existing' }), fetch: async (...args) => { calls.push(args); return response({ error: { message: 'stale', code: status === 401 ? 'SESSION_REQUIRED' : 'STALE_REVISION', details: { revision: 3 } }, meta: { request_id: 'req_x' } }, status, true); } };
    const c = createPlannerClient({ host });
    await assert.rejects(c.request('/routes/r/start', { method: 'POST', data: { base_revision: 1 } }), error => error.status === status && error.requestId === 'req_x' && error.details.revision === 3);
    assert.equal(calls.length, 1); assert.equal(c.isExpired(), status === 401); assert.equal(c.hasSession(), true);
  }
  let count = 0; const c = createPlannerClient({ host: { fetch: async () => { count++; throw new Error('disconnected'); } } });
  await assert.rejects(c.request('/routes', { method: 'POST', data: preferences }), /结果未知.*不会自动重发/); assert.equal(count, 1);
});

test('digital jiaozi receives genuine saved IDs, GCJ-02 places and no fabricated visit or award', () => {
  assert.equal(routeSnapshot(option, places), null);
  const snapshot = routeSnapshot({ ...option, route_id: 'route_real' }, places);
  assert.equal(snapshot.id, 'route_real'); assert.equal(snapshot.source, 'demo'); assert.equal(snapshot.places[0].id, 'ifs');
  assert.equal(snapshot.places[0].longitude, places[1].longitude); assert.equal('points' in snapshot, false); assert.equal('verified' in snapshot.places[0], false);
});

class Element extends EventTarget {
  constructor(tag, doc) {
    super(); this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.parentElement = null; this.attributes = {};
    Object.assign(this, { id: '', value: '', type: '', checked: false, disabled: false, hidden: false, className: '', isConnected: true, tabIndex: 0, text: '', rows: 0, maxLength: 0, min: '', max: '', step: '', required: false, placeholder: '' });
    this.classList = { add: name => { this.className += ' ' + name; } };
  }
  set textContent(value) { this.text = String(value ?? ''); this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (['id', 'value', 'type'].includes(k)) this[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  append(...nodes) {
    for (const n of nodes) {
      if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(x => x !== n);
      n.parentElement = this; this.children.push(n); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = n.value;
    }
  }
  prepend(n) { this.append(n); this.children = [n, ...this.children.filter(x => x !== n)]; }
  replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
  get firstElementChild() { return this.children[0]; } get lastElementChild() { return this.children.at(-1); }
  focus() { this.doc.activeElement = this; } showModal() { this.open = true; } close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 900 }; }
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); }
}
function descendants(el) { return [el, ...el.children.flatMap(descendants)]; }
async function flush() { for (let i = 0; i < 8; i++) await new Promise(setImmediate); }
function harness({ model = false, storedSession, storedLastRoute, initialRoutes = [], failEvent = false, override, onSouvenir } = {}) {
  const doc = { activeElement: null }; doc.createElement = tag => new Element(tag, doc); doc.body = new Element('body', doc);
  const entry = new Element('button', doc); entry.id = 'open-planner'; doc.body.append(entry); doc.activeElement = entry;
  doc.getElementById = id => descendants(doc.body).find(el => el.id === id);
  const calls = [], seenRoutes = [], seenPlaces = [], seenStates = [], storedRoutes = new Map(initialRoutes.map(r => [r.route_id, copy(r)])); let version = 1, positionRevision = 0, position = null, eventState = {};
  const host = { document: doc, localStorage: memory({ ...(storedSession ? { 'jiaozi-demo-session': storedSession } : {}), ...(storedLastRoute ? { 'jiaozi-last-route': storedLastRoute } : {}) }), fetch: async (url, config) => {
    const path = url.replace(/^\/planning(?:\/api\/v1)?/, ''), body = config.body ? JSON.parse(config.body) : null; calls.push({ path, method: config.method, body, headers: config.headers });
    const custom = await override?.({ path, method: config.method, body, headers: config.headers, storedRoutes }); if (custom !== undefined) return custom;
    if (path === '/health') return response({ status: 'ok', places_count: places.length, walking_segments_cached: 6 }, 200, true);
    if (path === '/demo/sessions') return response({ session_token: 'session_actual', business_now: '2026-10-31T14:00:00+08:00' });
    if (path === '/places') return response(places);
    if (path.startsWith('/places?')) return response([{ ...places[1], approx_distance_m: 200 }]);
    if (path.startsWith('/places/')) return response({ place: places.find(p => p.place_id === path.split('/').at(-1)), activity: { title: '演示活动', windows: [{ opens: '10:00', closes: '21:00' }], dwell_s: 1200, cost_min_fen: 0, cost_max_fen: 3000, benefits: [] }, queue: { duration_s: 60 }, opening_status: { value: 'open' }, crowd_density: { reason: '未知，不推测客流' }, notice: '演示配置', state_version: version });
    if (path === '/model-status') return response({ configured: model, model: 'test-model', structured_extraction_verified: model });
    if (path === '/chat' && config.method === 'GET') return response({ revision: 0, preferences: null, history: [] });
    if (path === '/chat') return response({ status: 'clarify', context_revision: 1, preferences, reply: '想去哪个商场？', operations: [], tool_trace: [{ name: 'get_place_details', status: 'success' }] });
    if (path === '/tools') return response({ tools: [{ name: 'get_place_details', description: '详情' }], agent_connected: model });
    if (path === '/tools/call') return response(body.name === 'plan_route_options' ? { options: [copy(option)] } : []);
    if (path === '/route-options') return response({ options: [copy(option), { ...copy(option), option_id: 'less_walking', title: '轻松漫步' }], notice: '两个不同的实际方案' });
    if (path === '/routes' && config.method === 'POST') { const r = { ...copy(option), route_id: 'route_actual', revision: 1, status: 'planned', is_favorite: false }; storedRoutes.set(r.route_id, r); return response(r); }
    if (path === '/routes' || path.startsWith('/routes?')) return response([...storedRoutes.values()].filter(r => !path.includes('favorite=true') || r.is_favorite));
    if (path === '/position') { position = body; positionRevision++; return response({ position, position_revision: positionRevision }); }
    if (path === '/dynamic-state') return response({ state_version: version, position_revision: positionRevision, position, states: eventState });
    if (path === '/demo/events') {
      if (failEvent) return response({ error: { code: 'STALE_STATE', message: '状态已变化' } }, 409, true);
      eventState = { [body.place_id]: body }; version++; return response({ state_version: version, position_revision: positionRevision, position, states: eventState });
    }
    const match = path.match(/^\/routes\/([^/]+)(\/\w+)?$/);
    if (match) {
      const r = storedRoutes.get(match[1]); if (!r) return response({ error: { message: '路线不存在' } }, 404, true);
      if (!match[2]) return response(copy(r));
      if (match[2] === '/favorite') { r.is_favorite = body.favorite; return response(copy(r)); }
      if (match[2] === '/start') { r.status = 'active'; r.revision++; return response(copy(r)); }
      if (match[2] === '/progress') { r.progress = { ...body, walked_m: body.actual_walk_m || 200 }; r.revision++; return response(copy(r)); }
      if (match[2] === '/assessment') return response({ route_revision: r.revision, state_version: version, position_ready: !!position, replan_suggested: true, reasons: [{ message: '演示排队增加' }], warnings: [], notice: '未修改路线' });
      if (match[2] === '/replan') return response({ route_modified: false, proposals: [{ proposal_id: 'proposal_actual', base_revision: r.revision, title: '剩余轻松路线', expires_at: new Date(Date.now() + 300000).toISOString(), route: copy(r), diff: { removed_place_ids: [], added_place_ids: [], old_remaining_order: ['ifs'], new_remaining_order: ['ifs'], completed_place_ids_unchanged: r.progress?.completed_place_ids || [] } }] });
      if (match[2] === '/accept') { r.revision++; return response(copy(r)); }
    }
    throw new Error(`unhandled ${config.method} ${path}`);
  } };
  const planner = setupMapPlanner({ host, onRoute: (r, p, meta) => seenRoutes.push({ r, p, meta }), onState: state => seenStates.push(state), onFocusPlace: p => seenPlaces.push(p), onSouvenir, getMapPosition: () => ({ longitude: 104.078, latitude: 30.655, coord_system: 'gcj02' }) });
  const all = () => descendants(doc.body);
  const click = async text => { const b = all().find(e => e.tagName === 'BUTTON' && e.textContent === text && !e.disabled); assert.ok(b, `button ${text}`); b.dispatchEvent(new Event('click')); await flush(); return b; };
  const control = label => { const wrapper = all().find(e => e.className === 'mp-field' && e.children[0]?.textContent === label); assert.ok(wrapper, `field ${label}`); return descendants(wrapper).find(e => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName)); };
  const submit = async () => { all().find(e => e.tagName === 'FORM').dispatchEvent(new Event('submit', { cancelable: true })); await flush(); };
  return { planner, doc, entry, calls, seenRoutes, seenPlaces, seenStates, click, control, all, submit, storedRoutes, host };
}

test('planner is fully lazy, preserves dialog state and restores focus, with form planning available without an LLM key', async () => {
  const h = harness(); assert.equal(h.calls.length, 0); assert.equal(h.doc.body.children.length, 1); assert.equal(h.planner.getRouteSnapshot(), null);
  h.entry.dispatchEvent(new Event('click')); await flush(); assert.equal(h.planner.isOpen(), true);
  assert.ok(h.doc.body.textContent.includes('自然语言模型 Key 尚未配置')); assert.equal(h.calls.filter(c => c.path === '/demo/sessions').length, 1);
  const dialog = h.doc.getElementById('map-planner'); h.planner.close(); assert.equal(h.doc.activeElement, h.entry);
  h.planner.open(); await flush(); assert.equal(h.doc.getElementById('map-planner'), dialog); assert.equal(h.calls.filter(c => c.path === '/health').length, 1);
  h.planner.destroy(); assert.equal(h.planner.isOpen(), false); h.planner.open(); assert.equal(h.planner.isOpen(), false);
});

test('actual UI generates, previews, saves, favorites and starts a route using server IDs and revision checks', async () => {
  const h = harness(); h.planner.open(); await flush();
  h.control('每人预算 / 元').value = '150.25'; h.control('单站排队上限 / 分钟').value = '15'; await h.submit();
  const generated = h.calls.find(c => c.path === '/route-options'); assert.equal(generated.body.budget_per_person_fen, 15025); assert.equal(generated.body.max_queue_s, 900);
  await h.click('选择并预览'); assert.equal(h.seenRoutes.at(-1).r.route_id, undefined); assert.deepEqual(h.seenRoutes.at(-1).p, places);
  assert.equal(h.planner.getRouteSnapshot(), null); await h.click('保存路线'); assert.equal(h.planner.getRoute().route_id, 'route_actual');
  assert.equal(h.planner.getRouteSnapshot().id, 'route_actual'); await h.click('收藏路线'); assert.equal(h.planner.getRoute().is_favorite, true);
  await h.click('开始路线'); assert.equal(h.planner.getRoute().status, 'active'); assert.equal(h.calls.find(c => c.path.endsWith('/start')).body.base_revision, 1);
  assert.equal(h.planner.getRoute().revision, 2); h.planner.destroy();
});

test('location requires explicit confirmation, then progress/replan/assessment use current versions and proposal acceptance', async () => {
  const h = harness(); h.planner.open(); await flush(); await h.submit(); await h.click('选择并预览'); await h.click('保存路线'); await h.click('开始路线');
  await h.click('读取地图中的人物位置'); assert.equal(h.calls.some(c => c.path === '/position'), false);
  await h.click('确认并上报位置'); assert.equal(h.calls.some(c => c.path === '/position'), false); assert.match(h.doc.body.textContent, /请先勾选/);
  h.control('我确认以上为本次测试使用的位置').checked = true; await h.click('确认并上报位置');
  const position = h.calls.find(c => c.path === '/position').body; assert.equal(position.source, 'demo'); assert.equal(position.confirmed, true); assert.equal(position.coord_system, 'gcj02');
  h.control('连续已完成到').value = '1'; await h.click('确认上报进度'); const progress = h.calls.find(c => c.path.endsWith('/progress')).body;
  assert.deepEqual(progress.completed_place_ids, ['ifs']); assert.equal(progress.base_revision, 2);
  await h.click('检查当前路线风险'); assert.match(h.doc.body.textContent, /演示排队增加/);
  await h.click('计算剩余路线 · 先预览'); const replan = h.calls.find(c => c.path.endsWith('/replan')).body;
  assert.equal(replan.base_revision, 3); assert.equal(replan.origin, 'last_completed'); assert.equal(h.planner.getRoute().revision, 3);
  await h.click('确认采用这条建议'); const accept = h.calls.find(c => c.path.endsWith('/accept')).body;
  assert.deepEqual(accept, { base_revision: 3, proposal_id: 'proposal_actual' }); assert.equal(h.planner.getRoute().revision, 4); h.planner.destroy();
});

test('state-event conflicts remain visible and do not replay a mutation or erase the current route', async () => {
  const h = harness({ failEvent: true }); h.planner.open(); await flush(); await h.submit(); await h.click('选择并预览'); await h.click('保存路线');
  h.control('营业状态').value = 'closed'; await h.click('提交演示状态'); assert.equal(h.calls.filter(c => c.path === '/demo/events').length, 1);
  assert.match(h.doc.body.textContent, /不会自动重试/); assert.equal(h.planner.getRoute().route_id, 'route_actual'); assert.equal(h.calls.filter(c => c.path === '/demo/sessions').length, 1); h.planner.destroy();
});

test('place discovery, tool catalog, chat clarification and selected-place context remain reachable', async () => {
  const h = harness({ model: true }); h.planner.open(); await flush(); await h.click('附近检索'); await h.click('成都 IFS · 直线约 200 米');
  assert.match(h.doc.body.textContent, /未知，不推测客流/); await h.click('询问这家店');
  const text = h.all().find(e => e.tagName === 'TEXTAREA'); text.value = '这家排多久'; await h.click('发送给逛吃助手');
  assert.equal(h.calls.find(c => c.path === '/chat' && c.method === 'POST').body.selected_place_id, 'ifs'); assert.match(h.doc.body.textContent, /想去哪个商场/);
  assert.match(h.doc.body.textContent, /工具调用轨迹/); await h.click('查看工具能力'); assert.equal(h.calls.some(c => c.path === '/tools'), true);
  await h.click('在地图查看'); assert.equal(h.seenPlaces.at(-1).place_id, 'ifs'); assert.equal(h.planner.isOpen(), false); h.planner.destroy();
});

test('saved route restoration uses the existing session and genuine server route without overwriting it', async () => {
  const restored = { ...copy(option), route_id: 'route_restored', revision: 4, status: 'active', is_favorite: true };
  const h = harness({ storedSession: 'persisted', storedLastRoute: restored.route_id, initialRoutes: [restored] });
  h.planner.open(); await flush();
  assert.equal(h.calls.some(c => c.path === '/demo/sessions'), false);
  assert.equal(h.planner.getRoute().route_id, restored.route_id); assert.equal(h.planner.getRoute().revision, 4);
  assert.equal(h.seenRoutes.at(-1).r.route_id, restored.route_id);
  const copyForCaller = h.planner.getRoute(); copyForCaller.stops.length = 0;
  assert.equal(h.planner.getRoute().stops.length, 1); h.planner.destroy();
});

test('an expired restored session waits for an explicit new-session action and clears the map route', async () => {
  const h = harness({ storedSession: 'expired', override: ({ path, headers }) => path !== '/health' && headers['X-Demo-Session'] === 'expired'
    ? response({ error: { code: 'SESSION_REQUIRED', message: '演示会话已过期' } }, 401, true) : undefined });
  h.planner.open(); await flush(); assert.equal(h.calls.some(c => c.path === '/demo/sessions'), false);
  assert.match(h.doc.body.textContent, /会话已失效/);
  await h.click('创建新演示会话');
  assert.equal(h.calls.filter(c => c.path === '/demo/sessions').length, 1);
  assert.equal(h.seenRoutes.at(-1).r, null); assert.equal(h.planner.getRouteSnapshot(), null);
  await h.submit(); assert.equal(h.calls.filter(c => c.path === '/route-options').length, 1); h.planner.destroy();
});

test('souvenir route handoff selects the loaded saved route and closes the source dialog before showing the planner', async () => {
  const saved = { ...copy(option), route_id: 'route_souvenir', revision: 3, status: 'planned', is_favorite: false };
  let finishLoading;
  const loaded = new Promise(resolve => { finishLoading = resolve; });
  const h = harness({ storedSession: 'persisted', initialRoutes: [saved], override: ({ path }) => path === '/routes/route_souvenir' ? loaded : undefined });
  const source = new Element('dialog', h.doc); source.id = 'souvenir-source'; h.doc.body.append(source); source.showModal(); source.focus();
  const events = [], createElement = h.doc.createElement;
  h.doc.createElement = tag => {
    const el = createElement(tag);
    if (tag === 'dialog') {
      const showModal = el.showModal;
      el.showModal = function () {
        events.push('planner-show');
        assert.equal(source.open, false, 'the source modal must close before the destination opens');
        assert.equal(h.planner.getRoute().route_id, saved.route_id);
        showModal.call(this);
      };
    }
    return el;
  };
  const opening = h.planner.openRoute(saved.route_id, { beforeOpen() {
    events.push('before-open');
    assert.equal(h.planner.isOpen(), false);
    assert.equal(h.doc.getElementById('map-planner').open, undefined);
    assert.equal(h.planner.getRoute().route_id, saved.route_id, 'handoff runs only after the requested saved route is selected');
    assert.equal(h.planner.getRoute().revision, saved.revision);
    assert.equal(h.seenRoutes.at(-1).r.route_id, saved.route_id);
    source.close(); h.entry.focus();
  } });
  await flush();
  assert.deepEqual(events, [], 'fetching a route must not close the current modal early');
  assert.equal(source.open, true); assert.equal(h.planner.isOpen(), false);
  finishLoading(response(saved));
  assert.equal(await opening, true);
  assert.deepEqual(events, ['before-open', 'planner-show']);
  assert.equal(h.planner.isOpen(), true); assert.equal(source.open, false);
  h.planner.close(); assert.equal(h.doc.activeElement, h.entry, 'focus restoration targets the map after handoff');
  h.planner.destroy();
});

test('opening an unavailable souvenir route preserves the current modal and reports the error only when planner is opened', async () => {
  const h = harness(), handoffs = [], beforeOpen = () => handoffs.push('handoff');
  assert.equal(await h.planner.openRoute('route_missing', { beforeOpen }), false);
  assert.equal(h.planner.isOpen(), false); assert.equal(h.doc.getElementById('map-planner').open, undefined);
  assert.deepEqual(handoffs, []);
  const requests = h.calls.length;
  assert.equal(await h.planner.openRoute('../not-a-route', { beforeOpen }), false);
  assert.equal(h.calls.length, requests); assert.deepEqual(handoffs, []);
  assert.equal(h.planner.isOpen(), false); assert.equal(h.doc.getElementById('map-planner').open, undefined);
  h.planner.open(); await flush();
  const error = h.all().find(e => e.className === 'mp-error'); assert.equal(error.hidden, false); assert.match(error.textContent, /路线不存在/);
  h.planner.destroy();
});

test('editing previously confirmed coordinates requires a new explicit position confirmation', async () => {
  const h = harness(); h.planner.open(); await flush();
  h.control('我确认以上为本次测试使用的位置').checked = true;
  const longitude = h.control('经度 · GCJ-02'); longitude.value = '104.079'; longitude.dispatchEvent(new Event('input'));
  assert.equal(h.control('我确认以上为本次测试使用的位置').checked, false);
  await h.click('确认并上报位置'); assert.equal(h.calls.some(c => c.path === '/position'), false);
  h.control('位置来源').value = 'manual'; h.control('位置来源').dispatchEvent(new Event('change'));
  h.control('我确认以上为本次测试使用的位置').checked = true; await h.click('确认并上报位置');
  const call = h.calls.find(c => c.path === '/position'); assert.equal(call.body.longitude, 104.079); assert.equal(call.body.source, 'manual'); h.planner.destroy();
});

test('switching away from a saved revision clears its pending proposal and assessment actions', async () => {
  const h = harness(); h.planner.open(); await flush(); await h.submit(); await h.click('选择并预览'); await h.click('保存路线');
  await h.click('检查当前路线风险'); await h.click('计算剩余路线 · 先预览');
  assert.ok(h.all().some(e => e.tagName === 'BUTTON' && e.textContent === '确认采用这条建议'));
  await h.click('选择并预览');
  assert.equal(h.planner.getRoute().route_id, undefined);
  assert.equal(h.all().some(e => e.tagName === 'BUTTON' && e.textContent === '确认采用这条建议'), false);
  assert.equal(h.calls.some(c => c.path.endsWith('/accept')), false); h.planner.destroy();
});

test('chat proposals remain previews until the explicit acceptance action and preserve revision checks', async () => {
  const h = harness({ model: true, override: ({ path, method, storedRoutes }) => {
    if (path !== '/chat' || method !== 'POST') return;
    const r = storedRoutes.get('route_actual');
    return response({ status: 'proposal', context_revision: 1, preferences: r.preferences, reply: '已计算替代路线，等待确认。',
      replan_proposals: [{ proposal_id: 'chat_proposal', base_revision: r.revision, expires_at: new Date(Date.now() + 300000).toISOString(), route: copy(r), diff: {} }] });
  } });
  h.planner.open(); await flush(); await h.submit(); await h.click('选择并预览'); await h.click('保存路线'); await h.click('开始路线');
  h.all().find(e => e.tagName === 'TEXTAREA').value = '少走一点'; await h.click('发送给逛吃助手');
  const request = h.calls.find(c => c.path === '/chat' && c.method === 'POST');
  assert.equal(request.body.route_id, 'route_actual'); assert.equal(request.body.base_revision, 2); assert.equal(request.body.context_revision, 0);
  assert.equal(h.calls.some(c => c.path.endsWith('/accept')), false); assert.equal(h.planner.getRoute().revision, 2);
  await h.click('查看重排差异并确认'); await h.click('确认采用这条建议');
  assert.deepEqual(h.calls.find(c => c.path.endsWith('/accept')).body, { base_revision: 2, proposal_id: 'chat_proposal' }); h.planner.destroy();
});

test('offline intent grammar extracts explicit constraints and rejects whole requests with unknown needs', () => {
  const original = copy(preferences);
  const result = parseRuleIntent('预算150元，逛两小时，保留IFS，不吃火锅，少走路，步行上限2公里，排队不超过10分钟', preferences, places);
  assert.deepEqual(result.unsupported, []); assert.equal(result.preferences.budget_per_person_fen, 15000);
  assert.equal(result.preferences.max_duration_s, 7200); assert.equal(result.preferences.max_walk_m, 2000); assert.equal(result.preferences.max_queue_s, 600);
  assert.equal(result.preferences.planning_style, 'less_walking'); assert.deepEqual(result.preferences.must_visit_ids, ['ifs']);
  assert.ok(result.preferences.excluded_interests.includes('hotpot')); assert.deepEqual(preferences, original);
  for (const text of ['预算150元，花生过敏', '预算150元，去不存在的店', '还剩两小时', '预算20000元', '保留IFS，不去IFS', '咖啡不要太苦']) {
    const blocked = parseRuleIntent(text, preferences, places); assert.equal(blocked.preferences, null, text); assert.ok(blocked.unsupported.length, text);
  }
});

test('offline intent is explicitly confirmed before filling fields and never silently saves or plans', async () => {
  const h = harness(); h.planner.open({ tab: 'plan', intent: '预算150元，逛两小时，保留IFS，不吃火锅' }); await flush();
  assert.equal(h.control('今天想怎么玩').value, '预算150元，逛两小时，保留IFS，不吃火锅');
  await h.click('整理我的想法'); assert.equal(h.control('每人预算 / 元').value, '200');
  assert.match(h.doc.body.textContent, /规则提取 · 待你核对/); assert.equal(h.calls.some(c => c.path === '/chat' && c.method === 'POST'), false);
  assert.equal(h.calls.some(c => c.path === '/route-options'), false); await h.click('确认填入规划条件');
  assert.equal(h.control('每人预算 / 元').value, '150'); assert.equal(h.control('可用时间 / 分钟').value, '120');
  assert.equal(h.calls.some(c => c.path === '/routes' && c.method === 'POST'), false);
  h.control('今天想怎么玩').value = '预算80元，必须花生过敏安全'; await h.click('整理我的想法');
  assert.equal(h.control('每人预算 / 元').value, '150'); assert.match(h.doc.body.textContent, /本次没有修改任何条件/); h.planner.destroy();
});

test('selected option strategy is retained when the server returned request preferences on every option', async () => {
  assert.equal(preferencesForOption({ ...option, option_id: 'less_walking' }).planning_style, 'less_walking');
  const h = harness(); h.planner.open(); await flush(); await h.submit();
  h.all().filter(e => e.tagName === 'BUTTON' && e.textContent === '选择并预览')[1].dispatchEvent(new Event('click')); await flush();
  assert.equal(h.planner.getRoute().preferences.planning_style, 'less_walking'); await h.click('保存路线');
  const save = h.calls.find(c => c.path === '/routes' && c.method === 'POST'); assert.equal(save.body.planning_style, 'less_walking'); h.planner.destroy();
});

test('intent entry invokes a configured model with the latest form instead of a stale chat draft', async () => {
  const h = harness({ model: true, override: ({ path, method }) => path === '/chat' && method === 'GET'
    ? response({ revision: 4, preferences: { ...preferences, budget_per_person_fen: 9900 }, history: [] }) : undefined });
  h.planner.open({ intent: '安排咖啡和拍照' }); await flush(); h.control('每人预算 / 元').value = '175'; await h.click('整理我的想法');
  const call = h.calls.find(c => c.path === '/chat' && c.method === 'POST');
  assert.equal(call.body.text, '安排咖啡和拍照'); assert.equal(call.body.current_preferences.budget_per_person_fen, 17500); assert.equal(call.body.context_revision, 4);
  assert.equal(h.calls.some(c => c.path === '/routes' && c.method === 'POST'), false); h.planner.destroy();
});

test('map exploration keeps the active route and live entry restores it without advancing any stops', async () => {
  const h = harness(); h.planner.open(); await flush(); await h.submit(); await h.click('选择并预览'); await h.click('保存路线'); await h.click('开始路线');
  await h.click('选中并进入地图'); assert.equal(h.planner.isOpen(), false); assert.equal(h.planner.getRoute().route_id, undefined);
  const state = h.planner.getGameState(); assert.equal(state.mode, 'preview'); assert.equal(state.activeRoute.route_id, 'route_actual');
  assert.equal(state.nextStop.place_id, 'ifs'); assert.equal(state.progress, null); assert.deepEqual(state.places, places);
  state.activeRoute.stops.length = 0; assert.equal(h.planner.getGameState().activeRoute.stops.length, 1);
  assert.equal(h.seenRoutes.at(-1).meta.mode, 'preview');
  h.planner.open({ tab: 'live' }); await flush(); assert.equal(h.planner.getRoute().route_id, 'route_actual');
  assert.equal(h.doc.getElementById('mp-panel-live').hidden, false); assert.equal(h.calls.some(c => c.path.endsWith('/progress')), false);
  assert.equal(h.seenStates.at(-1).activeRoute.revision, 2); h.planner.destroy();
});

test('live souvenir action passes the saved route only after explicit selection and does not award or advance it', async () => {
  const memories = [], h = harness({ onSouvenir: data => memories.push(data) }); h.planner.open({ tab: 'live' }); await flush();
  await h.click('保存本段旅程与照片'); assert.equal(memories.length, 0);
  await h.submit(); await h.click('选择并预览'); await h.click('保存路线'); await h.click('保存本段旅程与照片');
  assert.equal(memories[0].source, 'planner-live'); assert.equal(memories[0].route.route_id, 'route_actual'); assert.equal(memories[0].snapshot.id, 'route_actual');
  assert.equal(h.planner.isOpen(), false); assert.equal(h.calls.some(c => c.path.endsWith('/progress')), false); h.planner.destroy();
});
