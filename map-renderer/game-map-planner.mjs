// Complete module-a client. Coordinates crossing this boundary are GCJ-02;
// the map controller owns projection into its WGS84 scene.
const SESSION_KEY = 'jiaozi-demo-session', LAST_ROUTE_KEY = 'jiaozi-last-route';
export const DEMO_DEPARTURE = '2026-10-31T14:00';
export const INTERESTS = Object.freeze({ coffee: '咖啡', tea: '茶饮', food: '美食', hotpot: '火锅', landmark: '地标', launch: '首发', culture: '文化', lifestyle: '逛店', photo: '拍照', local: '本地风味' });
const STRATEGIES = { balanced: ['综合推荐', '逛吃与体验恰到好处'], less_walking: ['轻松漫步', '把脚步留给喜欢的街角'], more_experiences: ['多样探索', '遇见更多不同的成都'] };
const PATCH_KEYS = ['max_duration_s', 'budget_per_person_fen', 'max_walk_m', 'max_queue_s', 'buffer_s', 'interests', 'excluded_interests', 'must_visit_ids', 'excluded_place_ids', 'planning_style'];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const minutes = seconds => `${Math.ceil(Number(seconds || 0) / 60)} 分钟`;
const money = fen => (Number(fen || 0) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
function localTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return DEMO_DEPARTURE;
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16);
}
function dateWithTimezone(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value || '') || !Number.isFinite(Date.parse(`${value}+08:00`))) throw new Error('请选择有效的北京时间。');
  return `${value}:00+08:00`;
}
function numeric(value, min, max, label) {
  const n = typeof value === 'number' ? value : String(value).trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}应在 ${min}–${max} 之间。`);
  return n;
}
const list = value => Array.isArray(value) ? [...new Set(value)] : [];

export function preferencesFromFields(fields) {
  const start = String(fields.start || '').trim(), end = String(fields.end || '').trim();
  if (!start || start.length > 100 || end.length > 100) throw new Error('请选择有效起点和终点。');
  const required = list(fields.required), excluded = list(fields.excluded);
  if (required.length > 5 || excluded.length > 20) throw new Error('必去地点最多 5 个，排除地点最多 20 个。');
  if (required.some(id => excluded.includes(id))) throw new Error('同一地点不能同时设为必去和排除。');
  const interests = list(fields.interests), excludedInterests = list(fields.excludedInterests);
  if ([...interests, ...excludedInterests].some(key => !Object.hasOwn(INTERESTS, key))) throw new Error('兴趣标签无效。');
  if (!Object.hasOwn(STRATEGIES, fields.style || 'balanced')) throw new Error('请选择有效规划策略。');
  return {
    campaign_id: 'chunxi_demo_2026', start_place_id: start, end_place_id: end || null,
    departure_at: dateWithTimezone(fields.departure), max_duration_s: Math.round(numeric(fields.duration, 15, 720, '可用分钟') * 60),
    budget_per_person_fen: Math.round(numeric(fields.budget, 0, 10000, '每人预算') * 100),
    buffer_s: Math.round(numeric(fields.buffer ?? 10, 0, 60, '预留分钟') * 60),
    max_walk_m: Math.round(numeric(fields.walk, 0, 15000, '步行米数')),
    max_queue_s: Math.round(numeric(fields.queue ?? 20, 0, 180, '单站排队分钟') * 60),
    interests, excluded_interests: excludedInterests, must_visit_ids: required, excluded_place_ids: excluded,
    planning_style: fields.style || 'balanced', use_current_position: fields.usePosition === true
  };
}

// A deliberately limited offline grammar. Unknown clauses block the whole
// change, so a dietary, accessibility or timing condition cannot disappear.
export function parseRuleIntent(text, baseline, places = []) {
  const preferences = clone(baseline), changes = [], unsupported = [];
  const aliases = { coffee: ['喝咖啡', '咖啡'], tea: ['喝茶', '茶饮'], food: ['吃美食', '美食'], hotpot: ['吃火锅', '火锅'], landmark: ['看地标', '地标'], launch: ['首发'], culture: ['看文化', '文化'], lifestyle: ['逛商店', '逛店', '购物'], photo: ['拍照片', '拍照'], local: ['本地风味'] };
  const compact = value => String(value).replace(/[\s·（）()]/g, '').toLowerCase();
  const chinese = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: .5 };
  const number = value => Object.hasOwn(chinese, value) ? chinese[value] : Number(value);
  const amount = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十半])';
  function set(key, value, description) { preferences[key] = value; changes.push(description); }
  function resolvePlace(value) {
    const query = compact(value), found = places.filter(p => {
      const names = [p.name, p.place_id];
      if (/ifs/i.test(p.name)) names.push('IFS', '熊猫');
      for (const alias of ['太古里', '大慈寺', '龙抄手', '小龙坎', '无印良品', '星巴克', '喜茶']) if (p.name.includes(alias)) names.push(alias);
      return names.some(name => compact(name) === query);
    });
    return found.length === 1 ? found[0] : null;
  }
  const clauses = String(text || '').trim().split(/[，,；;。\n]+/).map(s => s.trim()).filter(Boolean);
  for (const clause of clauses) {
    let match;
    if ((match = clause.match(new RegExp(`^(?:每人)?预算(?:改成|改为|是|为)?\\s*${amount}\\s*元$`)))) {
      set('budget_per_person_fen', Math.round(number(match[1]) * 100), `每人预算 ¥${number(match[1])}`);
    } else if ((match = clause.match(new RegExp(`^(?:总共|总时长|可用时间|玩|逛)(?:改成|改为|为)?\\s*${amount}\\s*(小时|分钟)$`)))) {
      const seconds = number(match[1]) * (match[2] === '小时' ? 3600 : 60); set('max_duration_s', Math.round(seconds), `总时长 ${seconds / 60} 分钟`);
    } else if ((match = clause.match(new RegExp(`^(?:总)?步行(?:上限|最多|不超过)\\s*${amount}\\s*(米|公里)$`)))) {
      const metres = number(match[1]) * (match[2] === '公里' ? 1000 : 1); set('max_walk_m', Math.round(metres), `总步行不超过 ${metres} 米`);
    } else if ((match = clause.match(new RegExp(`^(?:单站)?排队(?:上限|最多|不超过)\\s*${amount}\\s*分钟$`)))) {
      set('max_queue_s', Math.round(number(match[1]) * 60), `单站排队不超过 ${number(match[1])} 分钟`);
    } else if (/^(?:少走路|少走一点|轻松漫步)$/.test(clause)) {
      set('planning_style', 'less_walking', '轻松漫步策略（未擅自改变步行上限）');
    } else if (/^(?:多样探索|多体验一点)$/.test(clause)) {
      set('planning_style', 'more_experiences', '多样探索策略');
    } else if (/^综合推荐$/.test(clause)) {
      set('planning_style', 'balanced', '综合推荐策略');
    } else if ((match = clause.match(/^(必去|保留|不去|排除)\s*(.+)$/))) {
      const place = resolvePlace(match[2]);
      if (!place || place.category === 'start') { unsupported.push(clause); continue; }
      const required = match[1] === '必去' || match[1] === '保留';
      const key = required ? 'must_visit_ids' : 'excluded_place_ids';
      set(key, list([...(preferences[key] || []), place.place_id]), `${required ? '必去' : '排除'}：${place.name}`);
    } else {
      const negative = /^(?:不要|不想|不吃|不喝)/.test(clause);
      let rest = clause.replace(/^(?:不要|不想|不吃|不喝|想要|想|兴趣[:：]?)/, '');
      const tags = [];
      for (const [tag, words] of Object.entries(aliases)) for (const word of words) {
        if (rest.includes(word)) { tags.push(tag); rest = rest.split(word).join(''); }
      }
      rest = rest.replace(/[\s、和与及+喝吃看逛]/g, '');
      if (rest || !tags.length) { unsupported.push(clause); continue; }
      const key = negative ? 'excluded_interests' : 'interests', other = negative ? 'interests' : 'excluded_interests';
      const unique = list(tags);
      set(key, list([...(preferences[key] || []), ...unique]), `${negative ? '不想体验' : '增加兴趣'}：${unique.map(t => INTERESTS[t]).join('、')}`);
      preferences[other] = (preferences[other] || []).filter(t => !unique.includes(t));
    }
  }
  if (!clauses.length) unsupported.push('请先写下想法。');
  const ranges = { budget_per_person_fen: [0, 1000000], max_duration_s: [900, 43200], max_walk_m: [0, 15000], max_queue_s: [0, 10800] };
  for (const [key, [min, max]] of Object.entries(ranges)) if (!Number.isFinite(preferences[key]) || preferences[key] < min || preferences[key] > max) unsupported.push(`条件超出范围：${key}`);
  if ((preferences.must_visit_ids || []).length > 5) unsupported.push('必去地点最多 5 个。');
  if ((preferences.must_visit_ids || []).some(id => (preferences.excluded_place_ids || []).includes(id))) unsupported.push('同一地点不能同时必去和排除，请在表单中调整。');
  return { preferences: unsupported.length ? null : preferences, changes, unsupported };
}

// The service may return the request's style on every option. Persist the
// strategy actually selected, otherwise saving can recalculate another route.
export function preferencesForOption(option) {
  const pref = clone(option?.preferences);
  if (pref && Object.hasOwn(STRATEGIES, option.option_id)) pref.planning_style = option.option_id;
  return pref;
}

export function routeSnapshot(route, places = []) {
  if (!route?.route_id) return null;
  const byId = new Map(places.map(place => [place.place_id, place]));
  return { id: route.route_id, title: route.title || `春熙路 · ${route.stops?.length || 0} 站探索`, source: 'demo',
    places: (route.stops || []).map(stop => {
      const p = byId.get(stop.place_id);
      return { id: stop.place_id, placeId: stop.place_id, name: p?.name || stop.name,
        ...(p ? { longitude: p.longitude, latitude: p.latitude, coordinateSystem: 'GCJ02' } : {}) };
    }) };
}

export class PlanningApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', details, requestId } = {}) {
    super(message); this.name = 'PlanningApiError'; Object.assign(this, { status, code, details, requestId });
  }
}

export function createPlannerClient({ host = window } = {}) {
  let storage;
  try { storage = host.localStorage; } catch { /* Session still works in memory when storage is unavailable. */ }
  const read = key => { try { return storage?.getItem(key) || null; } catch { return null; } };
  const write = (key, value) => { try { value == null ? storage?.removeItem(key) : storage?.setItem(key, value); } catch { /* Memory state remains authoritative. */ } };
  let token = read(SESSION_KEY), expired = false;
  async function request(path, { method = 'GET', data, authenticated = true } = {}) {
    if (!/^\/(?:[a-zA-Z0-9_/?=&.%:-]+)?$/.test(path) || path.startsWith('//') || path.includes('..')) throw new Error('无效路线接口。');
    let response;
    try {
      response = await host.fetch(`/planning${path === '/health' ? path : '/api/v1' + path}`, {
        method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(authenticated && token ? { 'X-Demo-Session': token } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {})
      });
    } catch {
      throw new PlanningApiError(method === 'GET' ? '路线服务连接失败，请检查服务后再刷新。' : '网络中断，提交结果未知。请先刷新记录核对，本次操作不会自动重发。');
    }
    let body;
    try { body = await response.json(); } catch { throw new PlanningApiError('路线服务未返回有效数据，请刷新核对。', { status: response.status, code: 'INVALID_RESPONSE' }); }
    if (!response.ok) {
      if (response.status === 401 && authenticated) expired = true;
      throw new PlanningApiError(body.error?.message || '路线请求失败。', { status: response.status, code: body.error?.code || 'REQUEST_FAILED', details: body.error?.details, requestId: body.meta?.request_id });
    }
    if (path === '/health') return body;
    if (!body || !Object.hasOwn(body, 'data')) throw new PlanningApiError('路线服务响应缺少 data，未应用更改。', { code: 'INVALID_RESPONSE' });
    return body.data;
  }
  return { request, health: () => request('/health', { authenticated: false }),
    async createSession() {
      const session = await request('/demo/sessions', { method: 'POST', authenticated: false, data: { clock_mode: 'demo' } });
      if (!session?.session_token) throw new PlanningApiError('会话创建失败：服务未返回会话凭据。', { code: 'INVALID_RESPONSE' });
      token = session.session_token; expired = false; write(SESSION_KEY, token); write(LAST_ROUTE_KEY, null); return session;
    }, hasSession: () => Boolean(token), isExpired: () => expired,
    lastRoute: () => read(LAST_ROUTE_KEY), rememberRoute: id => write(LAST_ROUTE_KEY, id) };
}

export function setupMapPlanner(options = {}) {
  const host = options.host || window, entry = host.document.getElementById('open-planner');
  let ui, destroyed = false;
  const ensure = () => ui ||= createPlannerUI({ ...options, host });
  const open = options => { if (!destroyed) ensure().open(options); };
  entry?.addEventListener('click', open);
  return { open, close: () => ui?.close(), isOpen: () => ui?.isOpen() || false,
    getRoute: () => ui?.getRoute() || null, getRouteSnapshot: () => ui?.getRouteSnapshot() || null,
    getGameState: () => ui?.getGameState() || { route: null, activeRoute: null, progress: null, nextStop: null, places: [], mode: 'none' },
    openRoute: (id, options) => destroyed ? Promise.resolve(false) : ensure().openRoute(id, options),
    destroy() { if (destroyed) return; destroyed = true; entry?.removeEventListener('click', open); ui?.destroy(); }
  };
}

function createPlannerUI({ onOpen, onClose, onRoute, onState, onFocusPlace, getMapPosition, onSouvenir, host }) {
  const doc = host.document, api = createPlannerClient({ host }), entry = doc.getElementById('open-planner');
  const make = (tag, text, className, attrs = {}) => {
    const el = doc.createElement(tag); if (text !== undefined && text !== null) el.textContent = text;
    if (className) el.className = className;
    for (const [key, value] of Object.entries(attrs)) key in el ? el[key] = value : el.setAttribute(key, String(value));
    return el;
  };
  const append = (parent, ...children) => { parent.append(...children.filter(Boolean)); return parent; };
  const button = (text, action, style = 'secondary') => {
    const b = make('button', text, `mp-button mp-${style}`, { type: 'button' });
    if (action) b.addEventListener('click', () => run(action, b)); return b;
  };
  const paragraph = text => make('p', text, 'mp-muted');
  const section = (title, subtitle) => append(make('section', null, 'mp-card'), make('h3', title), subtitle && paragraph(subtitle));
  const field = (label, el, description) => append(make('label', null, 'mp-field'), make('span', label), el, description && make('small', description, 'mp-muted'));
  const input = (type, value, options = {}) => make('input', null, '', { type, value: String(value), ...options });
  const select = options => {
    const s = make('select'); for (const [value, text] of options) s.append(make('option', text, '', { value })); return s;
  };
  const row = (...children) => append(make('div', null, 'mp-row'), ...children);
  const jsonDetails = (title, value) => append(make('details', null, 'mp-technical'), make('summary', title), make('pre', JSON.stringify(value, null, 2)));
  const notice = make('div', null, 'mp-feedback', { role: 'status', 'aria-live': 'polite', hidden: true });
  const alert = make('div', null, 'mp-error', { role: 'alert', hidden: true });
  const resetSessionButton = button('创建新演示会话', resetSession);
  const refreshButton = button('刷新当前资料', refresh);
  const recovery = row(refreshButton, resetSessionButton); recovery.hidden = true;
  const dialog = make('dialog', null, 'map-planner', { id: 'map-planner', 'aria-labelledby': 'mp-title' });
  const healthLabel = make('span', '首次打开时连接', 'mp-health');
  const heading = append(make('div'), make('div', 'CHUNXI · CITY QUEST', 'mp-eyebrow'), make('h2', '春熙路 · 路线工坊', '', { id: 'mp-title' }), paragraph('把喜欢的街角，串成今天的冒险。'));
  const closeButton = button('关闭 ×', null, 'quiet'); closeButton.addEventListener('click', close);
  append(dialog, append(make('header', null, 'mp-header'), heading, row(healthLabel, closeButton)));
  const nav = make('nav', null, 'mp-tabs', { role: 'tablist', 'aria-label': '路线工坊功能' });
  const content = make('div', null, 'mp-content'), panels = new Map(), tabButtons = new Map();
  for (const [id, label] of [['plan', '01  规划路线'], ['places', '02  街区地点'], ['live', '03  行程实况'], ['chat', '04  逛吃助手'], ['history', '05  我的路线']]) {
    const tab = button(label, () => { showTab(id); if (id === 'live') return loadDynamic(); if (id === 'history') return loadHistory(); });
    tab.setAttribute('role', 'tab'); tab.id = `mp-tab-${id}`; tab.setAttribute('aria-controls', `mp-panel-${id}`);
    tabButtons.set(id, tab); nav.append(tab);
    const panel = make('section', null, 'mp-tab-panel', { id: `mp-panel-${id}`, role: 'tabpanel', 'aria-labelledby': tab.id, hidden: id !== 'plan' });
    panels.set(id, panel); content.append(panel);
  }
  append(dialog, nav, append(make('div', null, 'mp-messages'), notice, alert, recovery), content,
    make('footer', '真实地点与百度步行路段 · 营业、消费、排队、福利为演示配置 · 商场入口未经人工复核，不含楼层内导航。', 'mp-footer'));
  doc.body.append(dialog);
  let opened = false, previousFocus, destroyed = false, initialized = false, initializing;
  let places = [], route = null, routeOptions = [], dynamic = null, modelStatus = null, chatContext = null, selectedPlace = null, busy = false;
  let activeRoute = null;
  let pendingProposals = [], chatResult = null, activeTab = 'plan', pendingRouteError = null;
  const controls = {}, boxes = {}, historyList = make('div', null, 'mp-history-list'), placeList = make('div', null, 'mp-place-list');
  const routeView = section('你的探索路线', '先设置偏好，再选择一个真实可行的方案。');
  const optionsView = make('div', null, 'mp-options'), optionsNotice = paragraph('三个策略独立计算；只有点位组合不同的可行路线才会显示。');
  const optionStatus = make('p', '还没有生成路线。', 'mp-muted');

  function feedback(message) { notice.textContent = message; notice.hidden = !message; }
  function showError(error) {
    alert.replaceChildren(make('strong', error.message || '操作暂未完成。'));
    if (error.status === 401) alert.append(paragraph('演示会话已失效。请明确创建新会话；旧操作不会自动重新提交。'));
    if (error.status === 409) alert.append(paragraph('版本或方案状态已变化。请刷新资料、重新预览并确认；本次变更不会自动重试。'));
    if (error.requestId) alert.append(paragraph(`请求编号：${error.requestId}`));
    if (error.details && Object.keys(error.details).length) alert.append(jsonDetails('查看条件冲突与详情', error.details));
    alert.hidden = false; recovery.hidden = false;
  }
  async function run(action, b) {
    if (destroyed || busy) return;
    busy = true; if (b) b.disabled = true; dialog.setAttribute('aria-busy', 'true'); alert.hidden = true;
    try { return await action(); } catch (error) { showError(error); } finally { busy = false; if (b?.isConnected) b.disabled = false; dialog.setAttribute('aria-busy', 'false'); }
  }
  function showTab(id) {
    if (!panels.has(id)) return;
    activeTab = id;
    for (const [key, panel] of panels) { panel.hidden = key !== id; tabButtons.get(key).setAttribute('aria-selected', String(key === id)); tabButtons.get(key).tabIndex = key === id ? 0 : -1; }
  }
  nav.addEventListener('keydown', event => {
    const keys = [...tabButtons.keys()], index = keys.indexOf(activeTab);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    showTab(keys[next]); tabButtons.get(keys[next]).focus();
    if (keys[next] === 'history' || keys[next] === 'live') run(keys[next] === 'history' ? loadHistory : loadDynamic);
  });
  function requireSession() { if (!initialized) throw new Error('路线服务正在连接，请稍后重试。'); if (api.isExpired()) throw new PlanningApiError('会话已失效，请创建新会话。', { status: 401, code: 'SESSION_REQUIRED' }); }
  function requireRoute() { requireSession(); if (!route?.route_id) throw new Error('请先选择并保存一条路线。'); return route; }
  const endpoint = (r, suffix = '') => `/routes/${encodeURIComponent(r.route_id)}${suffix}`;
  function gameState() {
    const progress = activeRoute?.progress || null, completed = progress?.completed_place_ids || [];
    return clone({ route, activeRoute, progress, nextStop: activeRoute?.stops?.find(stop => !completed.includes(stop.place_id)) || null,
      places, mode: route ? route.route_id ? 'saved' : 'preview' : 'none' });
  }
  function getPreferences() {
    return preferencesFromFields({ ...Object.fromEntries(Object.entries(controls).map(([key, el]) => [key, el.type === 'checkbox' ? el.checked : el.value])),
      interests: boxes.interests.filter(b => b.checked).map(b => b.value), excludedInterests: boxes.excludedInterests.filter(b => b.checked).map(b => b.value),
      required: boxes.required.filter(b => b.checked).map(b => b.value), excluded: boxes.excluded.filter(b => b.checked).map(b => b.value) });
  }
  function syncPreferences(pref) {
    if (!pref) return;
    const mapping = { start: pref.start_place_id, end: pref.end_place_id || '', departure: localTime(pref.departure_at), duration: pref.max_duration_s / 60,
      budget: pref.budget_per_person_fen / 100, buffer: pref.buffer_s / 60, walk: pref.max_walk_m, queue: pref.max_queue_s / 60, style: pref.planning_style };
    for (const [key, value] of Object.entries(mapping)) if (value !== undefined) controls[key].value = String(value);
    controls.usePosition.checked = Boolean(pref.use_current_position);
    for (const [key, prefKey] of [['interests', 'interests'], ['excludedInterests', 'excluded_interests'], ['required', 'must_visit_ids'], ['excluded', 'excluded_place_ids']])
      for (const b of boxes[key]) b.checked = (pref[prefKey] || []).includes(b.value);
    renderPreferenceSummary();
  }
  function checkGroup(key, entries, selected = []) {
    const group = make('div', null, 'mp-checks'); boxes[key] = [];
    for (const [value, title] of entries) { const check = input('checkbox', value, { checked: selected.includes(value) }); boxes[key].push(check); group.append(append(make('label'), check, make('span', title))); }
    return group;
  }
  function addControl(key, title, el, description) { controls[key] = el; return field(title, el, description); }
  const start = select([]), end = select([['', '最后一站结束']]);
  const form = make('form', null, 'mp-card mp-preferences');
  append(form, make('h3', '安排一段逛吃时光'), row(addControl('start', '出发地点', start), addControl('end', '结束地点', end)),
    addControl('departure', '出发时间 · 北京时间', input('datetime-local', DEMO_DEPARTURE, { required: true }), '演示商圈使用 2026-10-31 的营业与活动配置，可自行调整日期。'),
    row(addControl('duration', '可用时间 / 分钟', input('number', 180, { min: 15, max: 720, required: true })), addControl('budget', '每人预算 / 元', input('number', 200, { min: 0, max: 10000, step: .01, required: true }))),
    field('想体验什么', checkGroup('interests', Object.entries(INTERESTS), ['coffee', 'food', 'landmark'])),
    row(addControl('walk', '总步行上限 / 米', input('number', 4000, { min: 0, max: 15000, step: 1, required: true })),
      addControl('style', '偏好策略', select(Object.entries(STRATEGIES).map(([key, value]) => [key, value[0]])))));
  const requiredHolder = make('div'), excludedHolder = make('div');
  boxes.required = []; boxes.excluded = [];
  const advanced = append(make('details', null, 'mp-advanced'), make('summary', '高级约束 · 必去、排除与时间余量'));
  append(advanced, row(addControl('queue', '单站排队上限 / 分钟', input('number', 20, { min: 0, max: 180 })), addControl('buffer', '预留缓冲 / 分钟', input('number', 10, { min: 0, max: 60 }))),
    field('不想体验', checkGroup('excludedInterests', Object.entries(INTERESTS))),
    field('必去地点 · 最多 5 个', requiredHolder), field('排除地点', excludedHolder),
    addControl('usePosition', '从已确认的位置出发', input('checkbox', '', { checked: false }), '先在「行程实况」中明确上报位置；地图不会自动获取或上传 GPS。'));
  const generateButton = button('生成我的路线 →', null, 'primary'); generateButton.type = 'submit';
  append(form, advanced, generateButton); form.addEventListener('submit', event => { event.preventDefault(); run(generate, generateButton); });
  const planColumn = append(make('div'), append(section('每一段探索，都有自己的节奏'), optionsNotice, optionStatus, optionsView), routeView);
  const intentInput = input('text', '', { maxLength: 1000, placeholder: '例如：预算150元，逛两小时，保留IFS，不吃火锅', 'aria-label': '今天想怎么玩' });
  const intentMode = paragraph('正在读取规划能力…'), intentOutput = make('div', null, 'mp-intent-output', { 'aria-live': 'polite' });
  const preferenceSummary = paragraph(''), intentCard = section('今天，想怎样遇见成都？', '先说想法，再核对条件。已有路线不会被自动替换。');
  intentCard.classList.add('mp-intent-card');
  append(intentCard, intentMode, field('今天想怎么玩', intentInput), row(button('整理我的想法', prepareIntent, 'primary'),
    button('咖啡与镜头', () => setTheme(['coffee', 'photo', 'landmark'], 'balanced')),
    button('老成都慢游', () => setTheme(['culture', 'local', 'photo'], 'less_walking')),
    button('都市逛店', () => setTheme(['lifestyle', 'launch', 'landmark'], 'more_experiences'))), intentOutput,
    append(make('div', null, 'mp-preference-summary'), make('strong', '当前规划条件'), preferenceSummary));
  append(panels.get('plan'), intentCard, append(make('div', null, 'mp-plan-layout'), form, planColumn));
  for (const event of ['input', 'change']) {
    form.addEventListener(event, () => { intentOutput.replaceChildren(); renderPreferenceSummary(); });
    intentInput.addEventListener(event, () => intentOutput.replaceChildren());
  }
  function renderPreferenceSummary() {
    if (!places.length) return;
    try {
      const p = getPreferences(), name = id => places.find(place => place.place_id === id)?.name || id;
      preferenceSummary.textContent = `${p.use_current_position ? '已确认位置' : name(p.start_place_id)}出发 · ${minutes(p.max_duration_s)} · 每人 ¥${money(p.budget_per_person_fen)} · 步行 ≤ ${p.max_walk_m} 米 · 单站排队 ≤ ${minutes(p.max_queue_s)}\n兴趣：${p.interests.map(k => INTERESTS[k]).join('、') || '不限'} · 必去：${p.must_visit_ids.map(name).join('、') || '无'} · 排除：${p.excluded_place_ids.map(name).join('、') || '无'}`;
    } catch { preferenceSummary.textContent = '请先补全并核对下面的条件。'; }
  }
  function setTheme(interests, style) {
    requireSession(); const p = getPreferences();
    const blocked = interests.filter(tag => p.excluded_interests.includes(tag));
    if (blocked.length) throw new Error(`主题包含你已排除的${blocked.map(t => INTERESTS[t]).join('、')}，请先在高级约束中明确调整。`);
    syncPreferences({ ...p, interests, planning_style: style }); intentOutput.replaceChildren();
    feedback('已应用主题兴趣；时间、预算、必去与排除条件均保留。核对后再生成路线。');
  }
  async function prepareIntent() {
    requireSession(); const text = intentInput.value.trim();
    if (!text) throw new Error('先写下今天想怎么玩。');
    if (modelStatus?.configured) { showTab('chat'); await sendChat(text); return; }
    const result = parseRuleIntent(text, getPreferences(), places); intentOutput.replaceChildren();
    if (result.unsupported.length) {
      append(intentOutput, make('h4', '这些需求还需要你在表单中确认'), paragraph(`规则未识别：${result.unsupported.join('；')}。本次没有修改任何条件，也未计算路线。`),
        paragraph('当前规则仅支持明确的预算、总时长、步行/排队上限、兴趣、已知地点必去/排除和策略；不支持过敏安全、楼层、预约及任意复杂表述。'));
      return;
    }
    append(intentOutput, make('h4', '规则提取 · 待你核对'), paragraph(result.changes.join('\n')),
      paragraph('这是本地规则匹配；下方确认仅填写条件，不保存、不开始路线。'),
      button('确认填入规划条件', () => { syncPreferences(result.preferences); intentOutput.replaceChildren(paragraph('条件已填入。请核对下方表单，再生成路线；进行中的路线请到「行程实况」计算剩余路线。')); }, 'primary'));
  }

  const searchText = input('search', '', { placeholder: '搜索真实地点名称或地址', 'aria-label': '搜索地点' });
  const category = select([['', '全部类别'], ['coffee', '咖啡'], ['tea', '茶饮'], ['meal', '餐饮'], ['landmark', '地标'], ['culture', '文化'], ['lifestyle', '逛店'], ['start', '出发点']]);
  const nearbyAnchor = select([]), radius = input('number', 1500, { min: 1, max: 10000 });
  const placeDetail = section('选一个街角，看看有什么', '地点位置真实；客流密度尚无数据，不会用排队时间推测人数。');
  searchText.addEventListener('input', renderPlaces); category.addEventListener('change', renderPlaces);
  append(panels.get('places'), append(make('div', null, 'mp-place-layout'),
    append(section('街区地点', '在地图中查看位置，或查找某个地点周围的候选。'), row(searchText, category),
      row(field('附近检索中心', nearbyAnchor), field('半径 / 米', radius)), row(button('附近检索', nearbySearch), button('全部地点', () => { nearbyResults = null; renderPlaces(); })), placeList), placeDetail));
  let nearbyResults = null;
  function renderPlaces() {
    const query = searchText.value.trim().toLowerCase(), rows = (nearbyResults || places).filter(p => (!category.value || p.category === category.value) && `${p.name} ${p.address}`.toLowerCase().includes(query));
    placeList.replaceChildren();
    if (!rows.length) { placeList.append(paragraph('这个范围内没有匹配地点，可尝试放大半径或切换类别。')); return; }
    for (const p of rows) placeList.append(button(`${p.name}${p.approx_distance_m !== undefined ? ` · 直线约 ${p.approx_distance_m} 米` : ''}`, () => loadPlace(p.place_id), 'place'));
  }
  async function nearbySearch() {
    requireSession(); const p = places.find(p => p.place_id === nearbyAnchor.value); if (!p) throw new Error('请选择检索中心。');
    const args = { longitude: p.longitude, latitude: p.latitude, radius_m: Math.round(numeric(radius.value, 1, 10000, '检索半径')), ...(category.value ? { category: category.value } : {}) };
    nearbyResults = await api.request(`/places?${new URLSearchParams(args)}`); renderPlaces();
    feedback(`找到 ${nearbyResults.length} 个附近候选。距离为直线估算，步行时间以路线计算为准。`);
  }
  async function loadPlace(id) { requireSession(); const data = await api.request(`/places/${encodeURIComponent(id)}`); selectedPlace = id; renderPlace(data); }
  function renderPlace(data) {
    const p = data.place, activity = data.activity;
    placeDetail.replaceChildren(make('div', 'STREET DISCOVERY', 'mp-eyebrow'), make('h3', p.name), paragraph(p.address),
      row(button('在地图查看', async () => { await onFocusPlace?.(clone(p)); close(); }, 'primary'), button('询问这家店', () => { selectedPlace = p.place_id; chatSelected.value = p.place_id; showTab('chat'); chatInput.focus(); })),
      paragraph(`经纬度 ${p.longitude.toFixed(6)}, ${p.latitude.toFixed(6)} · GCJ-02 · ${p.entrance_reviewed ? '入口已复核' : '入口未人工复核'}`));
    if (activity) {
      placeDetail.append(make('h4', activity.title), paragraph(`营业状态：${({ open: '营业', closed: '关闭', unknown: '未知' })[data.opening_status?.value] || '未知'}（演示） · 排队 ${data.queue?.duration_s == null ? '未知' : minutes(data.queue.duration_s)}（演示）`),
        paragraph(`活动时段 ${(activity.windows || []).map(w => `${w.opens}–${w.closes}`).join(' / ')} · 停留 ${minutes(activity.dwell_s)} · 每人 ¥${money(activity.cost_min_fen)}–${money(activity.cost_max_fen)}（演示）`));
      for (const benefit of activity.benefits || []) placeDetail.append(append(make('div', null, 'mp-benefit'), make('strong', benefit.title), paragraph(`${benefit.conditions} · ${({ available: '演示可用', sold_out: '演示售罄', unknown: '库存未知' })[benefit.inventory_status] || '库存未知'}`)));
    } else placeDetail.append(paragraph('这个点位尚未配置演示活动、消费或营业信息。'));
    append(placeDetail, paragraph(`客流密度：${data.crowd_density?.reason || '未知，尚无可靠数据。'}`), paragraph(data.notice),
      jsonDetails('数据来源与更新时间', { location_source: p.location_source, retrieved_at: p.retrieved_at, state_version: data.state_version, queue: data.queue, opening_status: data.opening_status }));
  }

  const positionPlace = select([]), longitude = input('number', 104.077, { step: 'any', min: -180, max: 180 }), latitude = input('number', 30.653, { step: 'any', min: -85, max: 85 });
  const accuracy = input('number', 10, { min: 0, max: 10000 }), positionSource = select([['demo', '演示地点'], ['manual', '手工坐标']]);
  const confirmPosition = input('checkbox', '', { checked: false }), positionView = paragraph('尚未上传位置。');
  const positionCard = section('确认我的位置', '使用模拟地点或手填 GCJ-02 坐标。演示位置不代表设备定位；只有点击确认上报才写入会话。');
  for (const control of [longitude, latitude, accuracy, positionSource]) {
    for (const event of ['input', 'change']) control.addEventListener(event, () => { confirmPosition.checked = false; });
  }
  positionPlace.addEventListener('change', fillPositionFromPlace);
  append(positionCard, row(field('位置来源', positionSource), field('选择演示地点', positionPlace)),
    row(field('经度 · GCJ-02', longitude), field('纬度 · GCJ-02', latitude)), field('位置误差 / 米', accuracy),
    row(button('填入选定地点', fillPositionFromPlace), button('读取地图中的人物位置', async () => {
      const p = await getMapPosition?.(); if (!p || !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude)) throw new Error('地图当前没有可用的 GCJ-02 人物位置。');
      if (p.coord_system && p.coord_system !== 'gcj02' && p.coord_system !== 'GCJ02') throw new Error('地图返回的坐标不是 GCJ-02。');
      longitude.value = String(p.longitude); latitude.value = String(p.latitude); accuracy.value = String(p.accuracy_m ?? 10); positionSource.value = 'demo'; confirmPosition.checked = false;
      feedback('已填入地图人物的模拟坐标，请核对并勾选确认后再上报。');
    })), field('我确认以上为本次测试使用的位置', confirmPosition), button('确认并上报位置', submitPosition, 'primary'), positionView);
  function fillPositionFromPlace() {
    const p = places.find(p => p.place_id === positionPlace.value); if (!p) return;
    longitude.value = String(p.longitude); latitude.value = String(p.latitude); positionSource.value = 'demo'; confirmPosition.checked = false;
  }
  async function submitPosition() {
    requireSession(); if (!confirmPosition.checked) throw new Error('请先勾选确认本次测试的位置。');
    const result = await api.request('/position', { method: 'PUT', data: { longitude: numeric(longitude.value, -180, 180, '经度'), latitude: numeric(latitude.value, -85, 85, '纬度'),
      coord_system: 'gcj02', accuracy_m: numeric(accuracy.value, 0, 10000, '位置误差'), observed_at: new Date().toISOString(), source: positionSource.value, confirmed: true } });
    positionView.textContent = `已上传${result.position.source === 'demo' ? '演示' : '手工'}位置 · 版本 ${result.position_revision} · ${time(result.position.observed_at)}。两分钟后需重新确认。`;
    pendingProposals = []; renderProposals(); feedback('位置已明确上报。已有重排建议已清除，请重新计算后确认。'); await loadDynamic();
  }
  const eventPlace = select([]), eventStatus = select([['', '保持现状'], ['open', '演示营业'], ['closed', '演示关闭']]);
  const eventQueue = input('number', '', { min: 0, max: 240, placeholder: '留空保持原值' }), eventInventory = select([['', '保持现状'], ['available', '演示可用'], ['sold_out', '演示售罄'], ['unknown', '库存未知']]);
  const stateView = make('div'), eventCard = section('商家状态沙盘', '仅修改当前演示会话。营业、排队与福利库存均为测试数据。');
  append(eventCard, field('地点', eventPlace), row(field('营业状态', eventStatus), field('排队 / 分钟', eventQueue)), field('福利库存', eventInventory),
    button('提交演示状态', submitEvent), stateView);
  async function submitEvent() {
    requireSession(); if (!dynamic) throw new Error('请先刷新当前状态。');
    const data = { place_id: eventPlace.value, base_state_version: dynamic.state_version, source: 'demo' };
    if (eventStatus.value) data.status = eventStatus.value;
    if (eventQueue.value.trim() !== '') data.queue_s = Math.round(numeric(eventQueue.value, 0, 240, '排队分钟') * 60);
    if (eventInventory.value) data.inventory_status = eventInventory.value;
    if (Object.keys(data).length === 3) throw new Error('请选择至少一项需要变更的商家状态。');
    dynamic = await api.request('/demo/events', { method: 'POST', data }); renderDynamicState(); pendingProposals = []; renderProposals(); feedback('演示状态已更新。可评估当前路线，再计算替代方案。');
  }
  const liveRoute = make('div', null, 'mp-live-route'), completeCount = select([['0', '尚未完成站点']]);
  const progressAt = input('datetime-local', DEMO_DEPARTURE), spent = input('number', '', { min: 0, max: 10000, step: .01, placeholder: '留空使用保守估算' });
  const walked = input('number', '', { min: 0, max: 100000, placeholder: '留空使用已完成路段估算' }), progressSource = select([['demo', '演示进度'], ['self_reported', '本人上报']]);
  const progressCard = section('记录行程进度', '必须先开始路线。只能按行程顺序上报连续已完成站点；进度不是商家核销，不发放积分或奖励。');
  append(progressCard, liveRoute, field('连续已完成到', completeCount), field('行程时间 · 北京时间', progressAt), row(field('累计每人消费 / 元', spent), field('累计已步行 / 米', walked)), field('上报性质', progressSource), button('确认上报进度', submitProgress));
  if (onSouvenir) append(progressCard, button('保存本段旅程与照片', async () => {
    const current = requireRoute(); close();
    await onSouvenir({ route: clone(current), snapshot: routeSnapshot(current, places), source: 'planner-live' });
  }), paragraph('打开交子后自行选择旅程记忆与照片；保存记忆不会自动核销、发币或推进路线。'));
  async function submitProgress() {
    const current = requireRoute(); if (current.status !== 'active') throw new Error('请先开始这条路线。');
    const count = Number(completeCount.value), data = { base_revision: current.revision, completed_place_ids: current.stops.slice(0, count).map(s => s.place_id), effective_at: dateWithTimezone(progressAt.value), source: progressSource.value };
    if (spent.value.trim()) data.spent_per_person_fen = Math.round(numeric(spent.value, 0, 10000, '累计消费') * 100);
    if (walked.value.trim()) data.actual_walk_m = Math.round(numeric(walked.value, 0, 100000, '累计步行'));
    await selectRoute(await api.request(endpoint(current, '/progress'), { method: 'POST', data })); pendingProposals = []; renderProposals(); feedback('进度已保存；已完成点在后续重排中保持锁定。');
  }
  const assessmentView = make('div'), proposalView = make('div', null, 'mp-proposals');
  const replanOrigin = select([['planned_start', '原计划起点（未开始时）'], ['current_position', '已确认的当前位置'], ['last_completed', '最后一个已完成点']]);
  const replanAt = input('datetime-local', DEMO_DEPARTURE), replanReason = input('text', '调整剩余路线', { maxLength: 200 });
  const replanCard = section('应对街区变化', '先评估，再预览差异。只有点击「确认采用」才修改已保存路线。已完成点保留，建议有效期为 5 分钟。');
  append(replanCard, button('检查当前路线风险', assess), assessmentView, row(field('从哪里接着出发', replanOrigin), field('行程时间 · 北京时间', replanAt)), field('调整原因', replanReason),
    paragraph('重排将采用「规划路线」表单中当前的预算、总时长、步行、排队、兴趣与必去/排除条件；总时长包含已经用掉的时间。'),
    button('计算剩余路线 · 先预览', replan, 'primary'), proposalView);
  append(panels.get('live'), row(button('刷新位置与商家状态', loadDynamic)), append(make('div', null, 'mp-live-grid'), positionCard, eventCard, progressCard, replanCard));
  async function loadDynamic() { requireSession(); dynamic = await api.request('/dynamic-state'); renderDynamicState(); renderLiveRoute(); }
  function renderDynamicState() {
    stateView.replaceChildren(paragraph(`商家状态版本 ${dynamic.state_version} · 位置版本 ${dynamic.position_revision}`));
    if (dynamic.position) positionView.textContent = `${dynamic.position.source === 'demo' ? '演示' : '手工'}位置 ${Number(dynamic.position.longitude).toFixed(6)}, ${Number(dynamic.position.latitude).toFixed(6)} · ${time(dynamic.position.observed_at)}。两分钟后需重新确认。`;
    else positionView.textContent = '尚未上报位置。';
    const entries = Object.entries(dynamic.states || {});
    if (!entries.length) stateView.append(paragraph('尚无额外演示事件，正在使用活动配置中的初始状态。'));
    for (const [id, state] of entries) stateView.append(paragraph(`${places.find(p => p.place_id === id)?.name || id}：${({ open: '营业', closed: '关闭' })[state.status] || '营业未变'} · ${state.queue_s == null ? '排队未变' : '排队 ' + minutes(state.queue_s)} · ${({ available: '库存可用', sold_out: '库存售罄', unknown: '库存未知' })[state.inventory_status] || '库存未变'}`));
  }
  function renderLiveRoute() {
    liveRoute.replaceChildren(paragraph(route?.route_id ? `${route.stops.length} 站路线 · 版本 ${route.revision} · ${route.status === 'active' ? '进行中' : '尚未开始'}` : '先在规划页选择并保存路线。'));
    const oldCount = route?.progress?.completed_place_ids?.length || 0; completeCount.replaceChildren(make('option', '尚未完成站点', '', { value: '0' }));
    for (let i = 0; i < (route?.stops?.length || 0); i++) completeCount.append(make('option', `第 ${i + 1} 站 · ${route.stops[i].name}`, '', { value: String(i + 1), disabled: i + 1 < oldCount }));
    if (completeCount.firstElementChild) completeCount.firstElementChild.disabled = oldCount > 0;
    completeCount.value = String(oldCount); const when = localTime(route?.progress?.effective_at || route?.departure_at); progressAt.value = when; replanAt.value = when;
    replanOrigin.value = route?.status === 'active' ? oldCount ? 'last_completed' : 'current_position' : 'planned_start';
    spent.value = route?.progress?.spent_per_person_fen === undefined ? '' : String(route.progress.spent_per_person_fen / 100);
    walked.value = route?.progress?.walked_m === undefined ? '' : String(route.progress.walked_m);
  }
  async function assess() {
    const current = requireRoute(), result = await api.request(endpoint(current, '/assessment'));
    assessmentView.replaceChildren(make('h4', result.replan_suggested ? '建议调整剩余行程' : '当前规则未发现明显风险'));
    for (const item of [...(result.reasons || []), ...(result.warnings || [])]) assessmentView.append(paragraph(item.message));
    append(assessmentView, paragraph(`当前位置${result.position_ready ? '已就绪' : '尚未就绪或已过期'} · 路线版本 ${result.route_revision} · 状态版本 ${result.state_version}`), paragraph(result.notice));
  }
  async function replan() {
    const current = requireRoute(), pref = getPreferences(), patch = {};
    for (const key of PATCH_KEYS) if (JSON.stringify(pref[key]) !== JSON.stringify(current.preferences?.[key])) patch[key] = pref[key];
    const data = { base_revision: current.revision, effective_at: dateWithTimezone(replanAt.value), origin: replanOrigin.value, preference_patch: patch, reason: replanReason.value || 'user_request' };
    const result = await api.request(endpoint(current, '/replan'), { method: 'POST', data }); pendingProposals = result.proposals || []; renderProposals(); feedback('剩余路线已算好，原路线尚未修改。');
  }
  function renderProposals() {
    proposalView.replaceChildren();
    for (const proposal of pendingProposals) {
      const diff = proposal.diff || {}, names = ids => (ids || []).map(id => places.find(p => p.place_id === id)?.name || id).join(' → ') || '无';
      const card = section(proposal.title || '新的剩余路线'); card.classList.add('mp-proposal');
      append(card, paragraph(`移除：${names(diff.removed_place_ids)}；新增：${names(diff.added_place_ids)}`), paragraph(`原顺序：${names(diff.old_remaining_order)}`),
        paragraph(`新顺序：${names(diff.new_remaining_order)}`), paragraph(`已完成保持：${names(diff.completed_place_ids_unchanged)} · 预计剩余用时变化 ${Math.round((diff.remaining_duration_delta_s || 0) / 60)} 分钟`),
        paragraph(`有效至 ${time(proposal.expires_at)} · ${proposal.route?.stops?.length || 0} 站 · 预计结束 ${time(proposal.route?.planned_end_at)}`));
      for (const warning of diff.benefit_warnings || []) card.append(paragraph(warning));
      card.append(row(button('在地图预览', async () => { await onRoute?.(clone(proposal.route), clone(places), { mode: 'proposal', proposalId: proposal.proposal_id }); feedback('地图正在预览待确认建议；已保存路线尚未变更。'); close(); }),
        button('确认采用这条建议', () => acceptProposal(proposal), 'primary'))); proposalView.append(card);
    }
    if (!pendingProposals.length) proposalView.append(paragraph('目前没有待确认的重排建议。'));
  }
  async function acceptProposal(proposal) {
    const current = requireRoute();
    if (Date.parse(proposal.expires_at) <= Date.now()) throw new PlanningApiError('这条建议已过期，请重新计算。', { status: 409, code: 'STALE_PROPOSAL' });
    const saved = await api.request(endpoint(current, '/accept'), { method: 'POST', data: { base_revision: proposal.base_revision, proposal_id: proposal.proposal_id } });
    await selectRoute(saved); pendingProposals = []; renderProposals(); chatResult = null; renderChatResult(); await loadHistory(); feedback('已确认采用，路线版本已更新。');
  }

  const modelView = paragraph('正在读取模型状态。'), chatMessages = make('div', null, 'mp-chat-messages', { 'aria-live': 'polite' });
  const chatInput = make('textarea', null, '', { rows: 3, maxLength: 1000, placeholder: '例如：预算改成150元，保留IFS，不吃火锅', 'aria-label': '对话内容' });
  const chatSelected = select([['', '尚未选中地点']]), chatEffectiveAt = input('datetime-local', DEMO_DEPARTURE);
  const chatOrigin = select([['current_position', '已确认当前位置'], ['last_completed', '最后已完成点']]);
  const chatOutput = make('div'), chatSend = button('发送给逛吃助手', sendChat, 'primary');
  const chatPanel = section('用一句话，调整下一段旅程', '助手先查询、澄清并计算，确认后才保存或调整路线。');
  append(chatPanel, modelView, row(field('这家 / 这里 指代的地点', chatSelected), field('行程时间 · 已开始路线必填', chatEffectiveAt)), field('已开始路线的重排起点', chatOrigin), chatMessages, chatInput,
    row(chatSend, button('刷新对话与模型状态', loadChat)), chatOutput);
  const toolsView = make('div'), toolSelect = select([['get_place_details', '查询地点详情'], ['search_nearby_places', '查询附近地点'], ['plan_route_options', '计算路线方案']]);
  const toolCard = append(make('details', null, 'mp-advanced'), make('summary', '规划工具 · 查看能力与直接调用'),
    paragraph('查询工具只读，不保存路线、不发奖励。详情使用当前选中地点；附近查询使用地点页检索中心；规划使用当前表单。'), toolSelect,
    row(button('运行所选工具', callSelectedTool), button('查看工具能力', loadTools)), toolsView);
  append(panels.get('chat'), chatPanel, toolCard);
  async function loadChat() {
    requireSession(); const results = await Promise.all([api.request('/model-status'), api.request('/chat')]);
    modelStatus = results[0]; chatContext = results[1]; renderChatHistory(); renderModel();
  }
  function renderModel() {
    modelView.textContent = modelStatus?.configured ? `模型已配置：${modelStatus.model} · ${modelStatus.structured_extraction_verified ? '结构化解析已验证' : '连接尚未验证，可尝试发送'}。表单规划始终可用。` : '自然语言模型 Key 尚未配置。对话入口保留；现在可使用表单规划、地点查询与动态重排。';
    chatSend.disabled = !modelStatus?.configured;
    intentMode.textContent = modelStatus?.configured ? '真实模型辅助整理；仍由路线求解器核对营业、时间、预算和步行条件。' : '模型未配置 · 可用本地规则整理明确条件，或使用主题与完整表单。规则不会模拟 AI 理解。';
  }
  function renderChatHistory() {
    chatMessages.replaceChildren();
    for (const message of chatContext?.history || []) chatMessages.append(append(make('article', null, `mp-chat-message mp-chat-${message.role === 'user' ? 'user' : 'assistant'}`), make('strong', message.role === 'user' ? '你' : '逛吃助手'), paragraph(message.text)));
    if (!chatContext?.history?.length) chatMessages.append(paragraph('还没有对话。你可以修改多个条件，也可以询问某家店的排队或活动详情。'));
  }
  async function sendChat(textOverride) {
    requireSession(); if (!modelStatus?.configured) throw new Error('自然语言模型尚未配置，请使用表单与查询工具。');
    const text = (typeof textOverride === 'string' ? textOverride : chatInput.value).trim(); if (!text) throw new Error('先写下你想调整或查询的内容。');
    if (!chatContext) await loadChat();
    const data = { text, context_revision: chatContext.revision, current_preferences: getPreferences() };
    if (chatSelected.value) data.selected_place_id = chatSelected.value;
    if (route?.route_id) { data.route_id = route.route_id; data.base_revision = route.revision; }
    if (route?.status === 'active') { data.effective_at = dateWithTimezone(chatEffectiveAt.value); data.replan_origin = chatOrigin.value; }
    const result = await api.request('/chat', { method: 'POST', data });
    chatContext = { revision: result.context_revision, preferences: result.preferences, history: [...(chatContext.history || []), { role: 'user', text }, { role: 'assistant', text: result.reply }] };
    chatInput.value = ''; chatResult = result; renderChatHistory(); renderChatResult();
    if (result.preferences) syncPreferences(result.preferences);
  }
  function renderChatResult() {
    chatOutput.replaceChildren(); if (!chatResult) return;
    append(chatOutput, make('h4', ({ clarify: '还需要你确认', proposal: '已算出可行建议', answered: '查询结果', no_feasible_route: '当前约束暂无可行路线', not_available: '当前能力提示' })[chatResult.status] || '助手回复'), paragraph(chatResult.reply));
    if (chatResult.operations?.length) chatOutput.append(jsonDetails('识别到的调整与原文依据', chatResult.operations));
    if (chatResult.tool_trace?.length) chatOutput.append(jsonDetails('查看工具调用轨迹', chatResult.tool_trace));
    for (const item of chatResult.tool_results || []) chatOutput.append(jsonDetails(item.name === 'get_place_details' ? '地点查询结果' : '附近查询结果', item.data));
    if (chatResult.conflicts) chatOutput.append(jsonDetails('条件冲突', chatResult.conflicts));
    if (chatResult.status === 'clarify') chatOutput.append(paragraph('请在上方继续回答助手的问题。原路线尚未修改。'));
    if (chatResult.replan_proposals?.length) {
      pendingProposals = chatResult.replan_proposals; renderProposals(); chatOutput.append(button('查看重排差异并确认', () => showTab('live'), 'primary'));
    } else for (const option of chatResult.route_options || []) chatOutput.append(optionCard(option, true));
  }
  async function loadTools() { requireSession(); const data = await api.request('/tools'); toolsView.replaceChildren(jsonDetails('可用查询能力与输入定义', data)); }
  async function callSelectedTool() {
    requireSession(); const name = toolSelect.value; let args;
    if (name === 'get_place_details') {
      const id = chatSelected.value || selectedPlace || nearbyAnchor.value; if (!id) throw new Error('先选中要查询的地点。'); args = { place_id: id };
    } else if (name === 'search_nearby_places') {
      const p = places.find(p => p.place_id === nearbyAnchor.value); if (!p) throw new Error('先在地点页选择检索中心。');
      args = { longitude: p.longitude, latitude: p.latitude, radius_m: Math.round(numeric(radius.value, 1, 10000, '检索半径')), ...(category.value ? { category: category.value } : {}) };
    } else args = getPreferences();
    const result = await api.request('/tools/call', { method: 'POST', data: { name, arguments: args } });
    toolsView.replaceChildren(jsonDetails('工具查询结果', result));
    if (name === 'get_place_details') { selectedPlace = result.place.place_id; renderPlace(result); }
    if (name === 'search_nearby_places') { nearbyResults = result; renderPlaces(); }
    if (name === 'plan_route_options') { renderOptions(result); showTab('plan'); }
    feedback('查询工具已执行，尚未保存或开始任何路线。');
  }

  const favoriteOnly = input('checkbox', '', { checked: false });
  favoriteOnly.addEventListener('change', () => run(loadHistory));
  append(panels.get('history'), append(section('把喜欢的路线留给下次', '路线与收藏属于当前演示会话。开始、重排和进度均会检查版本。'), row(field('只看收藏', favoriteOnly), button('刷新路线', loadHistory), button('创建新演示会话', resetSession)), historyList));
  async function loadHistory() {
    requireSession(); const rows = await api.request(`/routes${favoriteOnly.checked ? '?favorite=true' : ''}`); historyList.replaceChildren();
    if (!favoriteOnly.checked && !activeRoute) {
      activeRoute = clone(rows.find(r => r.status === 'active') || null);
      if (activeRoute) await onState?.(gameState());
    }
    if (!rows.length) { historyList.append(paragraph('这里还没有路线。先生成方案，明确保存后就会出现在这里。')); return; }
    for (const r of rows) {
      const card = section(r.title || `${r.stops.length} 站 · ${STRATEGIES[r.preferences?.planning_style]?.[0] || '春熙探索'}`);
      append(card, paragraph(`${r.stops.map(s => s.name).join(' → ')} · ${r.is_favorite ? '已收藏 · ' : ''}${r.status === 'active' ? '进行中' : '待开始'} · 版本 ${r.revision}`),
        paragraph(`${time(r.departure_at)}–${time(r.planned_end_at)} · ${minutes(r.totals.duration_s)} · 步行 ${r.totals.walk_distance_m} 米`),
        row(button('打开并在地图预览', async () => { await selectRoute(await api.request(endpoint(r))); showTab('plan'); }),
          button(r.is_favorite ? '取消收藏' : '收藏', async () => { const updated = await api.request(endpoint(r, '/favorite'), { method: 'PUT', data: { favorite: !r.is_favorite } }); if (route?.route_id === r.route_id) await selectRoute(updated); await loadHistory(); })));
      historyList.append(card);
    }
  }
  async function generate() { requireSession(); const preferences = getPreferences(), result = await api.request('/route-options', { method: 'POST', data: preferences }); renderOptions(result); feedback('可行路线已生成，选择方案预览后可明确保存。'); }
  function renderOptions(result) {
    routeOptions = result.options || []; optionsView.replaceChildren(); optionStatus.textContent = `找到 ${routeOptions.length} 条不同的可行方案`; optionsNotice.textContent = result.notice || '不重复凑数；实际只显示有差异的可行路线。';
    for (const option of routeOptions) optionsView.append(optionCard(option));
    if (!routeOptions.length) optionsView.append(paragraph('当前没有可行方案，请调整时间、预算、必去或排除条件。'));
  }
  function optionCard(option, fromChat = false) {
    const strategy = STRATEGIES[option.option_id || option.preferences?.planning_style] || STRATEGIES.balanced, totals = option.totals || {};
    const card = section(option.title || strategy[0], strategy[1]); card.classList.add('mp-option');
    if (option.recommended) card.prepend?.(make('span', '推荐', 'mp-pill'));
    append(card, make('strong', `${option.stops?.length || 0} 站 · ${minutes(totals.duration_s)}`, 'mp-option-main'),
      paragraph(`步行 ${totals.walk_distance_m || 0} 米 · ¥${money(totals.cost_min_per_person_fen)}–${money(totals.cost_max_per_person_fen)}/人`),
      paragraph((option.stops || []).map(s => s.name).join(' → ')),
      row(button('选中并进入地图', async () => { await selectRoute(clone(option)); close(); }, 'primary'),
        button('选择并预览', async () => { await selectRoute(clone(option)); showTab('plan'); feedback('已选择方案并在地图显示。点击「保存路线」后才会加入历史。'); }),
        ...(fromChat ? [button('确认并保存', async () => { await saveOption(option); chatResult = null; renderChatResult(); }, 'secondary')] : [])));
    return card;
  }
  async function selectRoute(selected) {
    // Proposals and assessments belong to one exact saved revision. Choosing a
    // different route (including an unsaved preview) cannot keep those actions.
    if (route?.route_id !== selected?.route_id || route?.revision !== selected?.revision) {
      pendingProposals = []; renderProposals(); assessmentView.replaceChildren();
      chatResult = null; renderChatResult();
    }
    route = selected;
    if (route.status === 'active' && route.route_id) activeRoute = clone(route);
    if (!route.route_id) route.preferences = preferencesForOption(route);
    syncPreferences(route.preferences); renderRoute(); renderLiveRoute();
    chatEffectiveAt.value = localTime(route.progress?.effective_at || route.departure_at);
    if (route.route_id) api.rememberRoute(route.route_id);
    await onRoute?.(clone(route), clone(places), { mode: route.route_id ? 'saved' : 'preview' });
    await onState?.(gameState());
  }
  async function saveOption(option) {
    requireSession(); if (!option.preferences) throw new Error('方案缺少规划条件，请重新生成。');
    const saved = await api.request('/routes', { method: 'POST', data: preferencesForOption(option) }); await selectRoute(saved); await loadHistory(); feedback('路线已保存。保存时按最新状态重新校验，当前显示的是服务实际保存的路线。');
  }
  function renderRoute() {
    if (!route) { routeView.replaceChildren(make('h3', '你的探索路线'), paragraph('先设置偏好，再选择一个真实可行的方案。')); return; }
    const r = route, totals = r.totals || {}, saved = Boolean(r.route_id);
    routeView.replaceChildren(row(make('h3', `${r.stops?.length || 0} 站 · ${r.title || STRATEGIES[r.preferences?.planning_style]?.[0] || '春熙探索'}`),
      make('span', saved ? `${r.status === 'active' ? '进行中' : '已保存'} · v${r.revision}` : '方案预览 · 未保存', 'mp-pill')),
      paragraph(`${time(r.departure_at)} 出发 → ${time(r.planned_end_at)} 结束（含缓冲）`),
      append(make('div', null, 'mp-stats'), ...[[minutes(totals.duration_s), '总耗时'], [`${totals.walk_distance_m || 0} 米`, '步行'], [`¥${money(totals.cost_min_per_person_fen)}–${money(totals.cost_max_per_person_fen)}`, '每人估算']].map(([value, label]) => append(make('div'), make('strong', value), make('span', label)))));
    const actions = row(button('回到地图查看', close, 'primary'));
    if (!saved) actions.append(button('保存路线', () => saveOption(r)));
    else {
      actions.append(button(r.is_favorite ? '取消收藏' : '收藏路线', async () => { await selectRoute(await api.request(endpoint(r, '/favorite'), { method: 'PUT', data: { favorite: !r.is_favorite } })); await loadHistory(); }));
      const startButton = button(r.status === 'active' ? '路线已开始' : '开始路线', async () => { await selectRoute(await api.request(endpoint(r, '/start'), { method: 'POST', data: { base_revision: r.revision } })); await loadHistory(); feedback('路线已开始。可在行程实况中上报连续完成进度。'); });
      startButton.disabled = r.status === 'active'; actions.append(startButton);
      actions.append(button('查看行程实况', async () => { showTab('live'); await loadDynamic(); }));
      if (onSouvenir) actions.append(button('记入我的交子', async () => { close(); await onSouvenir(); }));
    }
    routeView.append(actions);
    const completed = r.progress?.completed_place_ids || [];
    for (const [i, stop] of (r.stops || []).entries()) {
      const card = append(make('article', null, 'mp-stop'), make('span', String(i + 1).padStart(2, '0'), 'mp-stop-number'),
        append(make('div'), make('h4', `${stop.name}${completed.includes(stop.place_id) ? ' · 已完成' : ''}`), paragraph(`${time(stop.arrival_at)} 抵达 · 步行 ${minutes(stop.walk_duration_s)} · 等待 ${minutes(stop.wait_duration_s)} · 排队 ${minutes(stop.queue_duration_s)} · 停留 ${minutes(stop.dwell_duration_s)}`),
          paragraph(`${stop.activity_title} · ¥${money(stop.cost_min_per_person_fen)}–${money(stop.cost_max_per_person_fen)}/人（演示）`), paragraph(stop.recommendation),
          button('地点与活动详情', async () => { await loadPlace(stop.place_id); showTab('places'); }, 'quiet')));
      for (const benefit of stop.benefits || []) card.lastElementChild.append(paragraph(`${benefit.title}：${benefit.conditions}（${({ sold_out: '演示售罄', available: '演示可用', unknown: '库存未知' })[benefit.inventory_status] || '库存未知'}）`));
      routeView.append(card);
    }
    for (const warning of r.warnings || []) routeView.append(paragraph(warning));
    routeView.append(jsonDetails('路线数据来源与版本', { route_id: r.route_id, revision: r.revision, sources: r.sources, state_version: r.state_version, position_revision: r.position_revision,
      walking: (r.legs || []).map(l => ({ from: l.from_place_id, to: l.to_place_id, source: l.source, delivery: l.delivery, retrieved_at: l.retrieved_at, entrance_version: l.entrance_version })) }));
  }
  function populatePlaces() {
    for (const s of [start, end, nearbyAnchor, positionPlace, eventPlace, chatSelected]) {
      const blank = s === end || s === chatSelected; s.replaceChildren();
      if (blank) s.append(make('option', s === end ? '最后一站结束' : '尚未选中地点', '', { value: '' }));
      for (const p of places) s.append(make('option', p.name, '', { value: p.place_id }));
    }
    const defaultId = places.some(p => p.place_id === 'chunxi_start') ? 'chunxi_start' : places[0]?.place_id || '';
    start.value = defaultId; nearbyAnchor.value = defaultId; positionPlace.value = defaultId;
    for (const key of ['required', 'excluded']) (key === 'required' ? requiredHolder : excludedHolder)
      .replaceChildren(checkGroup(key, places.filter(p => p.category !== 'start').map(p => [p.place_id, p.name])));
    renderPlaces(); fillPositionFromPlace(); renderPreferenceSummary();
  }

  async function refresh() {
    if (!initialized) return initialize();
    requireSession(); const selectedId = route?.route_id;
    places = await api.request('/places'); populatePlaces();
    if (selectedId) await selectRoute(await api.request(`/routes/${encodeURIComponent(selectedId)}`));
    await Promise.all([loadHistory(), loadDynamic(), loadChat()]); feedback('资料已刷新。请核对新版本后再提交变更。'); recovery.hidden = true;
  }
  async function initialize() {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      healthLabel.textContent = '正在连接路线服务…';
      const health = await api.health();
      if (!api.hasSession()) await api.createSession();
      places = await api.request('/places'); initialized = true; populatePlaces();
      healthLabel.textContent = `${health.places_count ?? places.length} 个地点 · ${health.walking_segments_cached ?? 0} 条真实缓存路段`;
      await Promise.all([loadHistory(), loadDynamic(), loadChat()]);
      const id = api.lastRoute();
      if (id) {
        try { await selectRoute(await api.request(`/routes/${encodeURIComponent(id)}`)); }
        catch (error) { if (error.status === 404) { api.rememberRoute(null); feedback('上次的路线已不在当前会话中，可从历史重新选择。'); } else throw error; }
      }
    })();
    try { await initializing; } catch (error) { healthLabel.textContent = '路线服务需要处理'; throw error; } finally { initializing = null; }
  }
  async function resetSession() {
    await api.health(); const session = await api.createSession();
    route = null; activeRoute = null; routeOptions = []; pendingProposals = []; chatResult = null; chatContext = null; dynamic = null; selectedPlace = null; nearbyResults = null; initialized = false;
    renderRoute(); optionsView.replaceChildren(); optionStatus.textContent = '还没有生成路线。'; renderProposals(); renderChatResult();
    pendingRouteError = null; await onRoute?.(null, clone(places));
    await onState?.(gameState());
    await initialize(); feedback(`已创建新演示会话。业务日期 ${session.business_now?.slice(0, 10) || '2026-10-31'}，旧会话路线不会自动迁移。`); recovery.hidden = true;
  }
  function open(options = {}) {
    if (destroyed) return;
    if (!opened) { previousFocus = doc.activeElement; opened = true; dialog.showModal(); entry?.setAttribute('aria-expanded', 'true'); onOpen?.(); }
    closeButton.focus(); run(async () => {
      await initialize();
      if (options?.tab === 'live' && activeRoute && route?.route_id !== activeRoute.route_id) await selectRoute(clone(activeRoute));
      if (panels.has(options?.tab)) showTab(options.tab);
      if (typeof options?.intent === 'string') { intentInput.value = options.intent.slice(0, 1000); showTab('plan'); intentInput.focus(); }
      if (pendingRouteError) { const error = pendingRouteError; pendingRouteError = null; showError(error); }
    });
  }
  function close() {
    if (!opened) return;
    opened = false; dialog.close(); entry?.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected) previousFocus.focus(); onClose?.();
  }
  const onCancel = event => { event.preventDefault(); close(); };
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return; const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
  });
  showTab('plan'); renderProposals();
  return { open, close, isOpen: () => opened, getRoute: () => clone(route), getRouteSnapshot: () => routeSnapshot(route, places), getGameState: gameState,
    async openRoute(id, { beforeOpen } = {}) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return false;
      try { await initialize(); await selectRoute(await api.request(`/routes/${encodeURIComponent(id)}`)); beforeOpen?.(); showTab('plan'); open(); return true; }
      catch (error) { if (opened) showError(error); else pendingRouteError = error; return false; }
    },
    destroy() { if (destroyed) return; close(); destroyed = true; dialog.remove(); }
  };
}
