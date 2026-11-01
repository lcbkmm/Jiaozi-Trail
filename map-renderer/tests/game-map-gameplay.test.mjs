import test from 'node:test';
import assert from 'node:assert/strict';
import { chinaDay, stationVisit, journeyTask, experienceStations, EXPERIENCE_STATIONS, createGameHub } from '../game-map-gameplay.mjs';

class Element extends EventTarget {
  constructor(doc) { super(); this.doc = doc; this.children = []; this.attributes = {}; this.isConnected = true; this.html = ''; }
  append(child) { this.children.push(child); }
  remove() { this.isConnected = false; }
  setAttribute(key, value) { this.attributes[key] = value; }
  set innerHTML(value) { this.html = value; }
  get innerHTML() { return this.html; }
  querySelector() { return { focus() {} }; }
  focus() { this.doc.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const wallet = (balance = 0, merchantCheckins = []) => ({ wallet: { balance, earned: balance }, merchantCheckins, demo: true, sample: false });
const visit = (merchantId = 'ifs') => ({ id: 'visit-' + merchantId, merchantId, occurredAt: new Date().toISOString(), day: chinaDay(), amount: 10, source: 'demo' });
const issued = (merchantId = 'ifs', awarded = 10, duplicate = false) => ({ ...wallet(awarded, [visit(merchantId)]), lastCheckin: { checkin: visit(merchantId), awarded, duplicate } });
const route = { route_id: 'route-one', stops: [{ place_id: 'a', name: '第一站' }, { place_id: 'b', name: '第二站' }] };
const routeState = () => ({ route, activeRoute: route, mode: 'saved', progress: { completed_place_ids: [] } });
function harness({ getState, issueDemo, onPlanner, onPlayer, onFocusMerchant } = {}) {
  const doc = {}; doc.body = new Element(doc); const stage = new Element(doc), initialFocus = new Element(doc); doc.activeElement = initialFocus;
  doc.getElementById = id => id === 'stage' ? stage : null; doc.createElement = () => new Element(doc);
  const changes = [], calls = [], navigation = [];
  const hub = createGameHub({ host: { document: doc, crypto: { randomUUID: () => 'stable-request' } },
    merchants: [{ id: 'ifs', name: 'IFS 探索站', position: [1, 2] }, { id: 'taikoo', name: '太古里探索站', description: '<img src=x>' }], getState,
    issueDemo: issueDemo || (async payload => { calls.push(payload); return issued(payload.merchantId); }), onOpenChange: value => changes.push(value),
    onPlanner: onPlanner || (tab => navigation.push({ type: 'planner', tab, opened: hub.isOpen() })),
    onPlayer: onPlayer || (tab => navigation.push({ type: 'player', tab, opened: hub.isOpen() })),
    onFocusMerchant: onFocusMerchant || (merchant => navigation.push({ type: 'focus', merchant, opened: hub.isOpen() })) });
  const quest = stage.children[0], dialog = doc.body.children[0];
  function click(action, merchant, { disabled = false, fromQuest = false } = {}) {
    const target = { disabled, dataset: { gameAction: action, merchant } }, event = new Event('click');
    Object.defineProperty(event, 'target', { value: { closest: () => target } }); (fromQuest ? quest : dialog).dispatchEvent(event);
  }
  return { hub, doc, quest, dialog, click, changes, calls, navigation, initialFocus };
}

test('daily visits use Beijing midnight, tolerate corrupt old entries, and never confuse invalid dates', () => {
  assert.equal(chinaDay(new Date('2026-11-01T15:59:59Z')), '2026-11-01');
  assert.equal(chinaDay(new Date('2026-11-01T16:00:00Z')), '2026-11-02');
  assert.equal(chinaDay(new Date('broken')), null); assert.equal(chinaDay(null), null);
  const record = { merchantId: 'ifs', occurredAt: '2026-11-01T16:01:00Z' };
  const state = { merchantCheckins: [null, { merchantId: 'ifs', occurredAt: 'broken' }, { merchantId: 'ifs' }, record] };
  assert.equal(stationVisit(state, 'ifs', new Date('2026-11-02T01:00:00+08:00')), record);
  assert.equal(stationVisit(state, 'ifs', new Date('2026-11-01T23:00:00+08:00')), null);
  assert.equal(stationVisit(state, 'ifs', new Date('broken')), null);
  assert.equal(stationVisit({ merchantCheckins: {} }, 'ifs'), null);
});

test('quest completion only counts this route, keeps previews separate, and restores active-only sessions', () => {
  const state = { ...routeState(), progress: { completed_place_ids: ['a', 'unrelated', 'unrelated'] } };
  assert.match(journeyTask(state).subtitle, /1 \/ 2/); assert.equal(journeyTask(state).title, '下一站 · 第二站');
  assert.equal(journeyTask({ ...state, progress: { completed_place_ids: ['a', 'b', 'other'] } }).complete, true);
  const preview = journeyTask({ ...state, mode: 'preview' }); assert.match(preview.subtitle, /0 \/ 2/); assert.equal(preview.complete, false); assert.equal(preview.action, 'plan');
  const restored = journeyTask({ activeRoute: { ...route, progress: { completed_place_ids: ['a'] } }, mode: 'none' });
  assert.equal(restored.title, '下一站 · 第二站'); assert.equal(restored.action, 'live');
  assert.equal(journeyTask(null).action, 'plan');
});

test('experience stations require actual finite map positions and copy coordinates', () => {
  const place = { id: EXPERIENCE_STATIONS[0].placeId, name: '真实 IFS', position: [123, 456] };
  const stations = experienceStations([place, { id: EXPERIENCE_STATIONS[1].placeId, position: [NaN, 3] }]);
  assert.equal(stations.length, 1); assert.equal(stations[0].placeName, '真实 IFS'); stations[0].position[0] = 0; assert.equal(place.position[0], 123);
  assert.deepEqual(experienceStations(null), []);
});

test('opening synchronizes the shared wallet, blocks unknown balances, and never grants on selection', async () => {
  const pending = deferred(), h = harness({ getState: () => pending.promise });
  h.hub.openCheckin('taikoo'); assert.deepEqual(h.changes, [true]); assert.match(h.dialog.innerHTML, /正在同步试玩钱包/);
  h.click('prepare-issue', 'taikoo'); assert.ok(!h.dialog.innerHTML.includes('merchant-confirm')); assert.equal(h.calls.length, 0);
  pending.resolve(wallet()); await tick(); h.click('prepare-issue', 'taikoo'); assert.match(h.dialog.innerHTML, /确认试玩打卡/); assert.ok(!h.dialog.innerHTML.includes('<img src=x>'));
  h.click('cancel-issue'); assert.ok(!h.dialog.innerHTML.includes('merchant-confirm')); assert.equal(h.calls.length, 0);
  h.hub.close(); assert.equal(h.doc.activeElement, h.initialFocus); assert.deepEqual(h.changes, [true, false]); h.hub.destroy();
});

test('a confirmed check-in calls one bridge transaction and reports the actual awarded amount', async () => {
  const pending = deferred(), calls = [], h = harness({ issueDemo: payload => { calls.push(payload); return pending.promise; } });
  h.hub.setWalletState(wallet()); h.hub.setRouteState(routeState()); h.hub.openCheckin('ifs'); h.click('prepare-issue', 'ifs');
  assert.equal(calls.length, 0); h.click('issue'); h.click('issue'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { merchantId: 'ifs', eventId: 'stable-request', source: 'demo', routeId: 'route-one' });
  pending.resolve(issued('ifs', 7)); await tick(); assert.match(h.dialog.innerHTML, /7 枚试玩交子已到账/); assert.ok(!h.dialog.innerHTML.includes('10 枚试玩交子已到账'));
  assert.match(h.quest.innerHTML, /1\/2/); h.click('prepare-issue', 'ifs'); h.click('issue'); assert.equal(calls.length, 1); h.hub.destroy();
});

test('duplicate or absent receipts never claim a fresh ten-token award', async () => {
  for (const [response, expected] of [[issued('ifs', 0, true), /今日已经领过，未重复发放/], [issued('ifs', 0), /本次未新增试玩交子/], [wallet(10), /未收到可核对的打卡回执/], [{ ...issued(), lastCheckin: { ...issued().lastCheckin, checkin: visit('taikoo') } }, /未收到可核对的打卡回执/]]) {
    const h = harness({ issueDemo: async () => response }); h.hub.setWalletState(wallet()); h.hub.openCheckin('ifs'); h.click('prepare-issue', 'ifs'); h.click('issue'); await tick();
    assert.match(h.dialog.innerHTML, expected); assert.ok(!h.dialog.innerHTML.includes('10 枚试玩交子已到账')); h.hub.destroy();
  }
});

test('only the displayed saved active route is attached to the bridge request', async () => {
  for (const state of [{ ...routeState(), route: { stops: [] }, mode: 'preview' }, { ...routeState(), mode: 'none' }, { ...routeState(), route: { ...route, route_id: 'another-saved-route' } }]) {
    const h = harness(); h.hub.setWalletState(wallet()); h.hub.setRouteState(state);
    h.hub.openCheckin('ifs'); h.click('prepare-issue', 'ifs'); h.click('issue'); await tick(); assert.equal(h.calls[0].routeId, undefined); h.hub.destroy();
  }
});

test('failed submission preserves the request ID for explicit retry and does not fabricate a visit', async () => {
  const calls = [], h = harness({ issueDemo: async payload => { calls.push(payload); if (calls.length === 1) throw Error('连接中断'); return issued(); } });
  h.hub.setWalletState(wallet()); h.hub.openCheckin('ifs'); h.click('prepare-issue', 'ifs'); h.click('issue'); await tick();
  assert.match(h.dialog.innerHTML, /连接中断/); assert.match(h.dialog.innerHTML, /重试会沿用本次请求编号/); assert.match(h.quest.innerHTML, /0\/2/);
  h.click('issue'); await tick(); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.match(h.dialog.innerHTML, /已到账/); h.hub.destroy();
});

test('pushed check-ins invalidate stale confirmations and reject sample wallets', () => {
  const h = harness(); h.hub.setWalletState(wallet()); h.hub.openCheckin('ifs'); h.click('prepare-issue', 'ifs');
  h.hub.setWalletState({ ...wallet(100, [visit()]), sample: true }); assert.match(h.quest.innerHTML, /0\/2/);
  h.hub.setWalletState(wallet(10, [visit()])); assert.ok(!h.dialog.innerHTML.includes('merchant-confirm')); h.click('issue'); assert.equal(h.calls.length, 0);
  h.click('station', 'taikoo'); h.click('prepare-issue', 'taikoo'); h.hub.setRouteState(routeState()); assert.ok(!h.dialog.innerHTML.includes('merchant-confirm')); h.hub.destroy();
});

test('late refreshes and failed refreshes cannot overwrite a newer pushed wallet', async () => {
  const pending = deferred(), h = harness({ getState: () => pending.promise }); h.hub.openCheckin(); h.hub.setWalletState(wallet(10, [visit()]));
  pending.resolve(wallet()); await tick(); assert.match(h.quest.innerHTML, /1\/2/); h.hub.destroy();
  const staleFailure = deferred(), other = harness({ getState: () => staleFailure.promise }); other.hub.openCheckin(); other.hub.setWalletState(wallet());
  staleFailure.reject(Error('旧请求错误')); await tick(); assert.ok(!other.dialog.innerHTML.includes('旧请求错误')); other.hub.destroy();
});

test('refresh failures are visible and explicit refresh can recover without issuing', async () => {
  let attempts = 0; const h = harness({ getState: async () => { if (!attempts++) throw Error('钱包未响应'); return wallet(10, [visit()]); } });
  h.hub.openCheckin(); await tick(); assert.match(h.dialog.innerHTML, /钱包未响应/); h.click('refresh'); await tick();
  assert.ok(!h.dialog.innerHTML.includes('钱包未响应')); assert.match(h.quest.innerHTML, /1\/2/); assert.equal(h.calls.length, 0); h.hub.destroy();
});

test('in-flight refresh cannot undo a confirmed issuance and later push remains authoritative', async () => {
  const pending = deferred(), h = harness({ getState: () => pending.promise }); h.hub.setWalletState(wallet()); h.hub.openCheckin('ifs'); h.click('prepare-issue', 'ifs'); h.click('issue'); await tick();
  pending.resolve(wallet()); await tick(); assert.match(h.quest.innerHTML, /1\/2/); h.hub.destroy();
  const result = deferred(), other = harness({ issueDemo: () => result.promise }); other.hub.setWalletState(wallet()); other.hub.openCheckin(); other.click('prepare-issue', 'ifs'); other.click('issue');
  other.hub.setWalletState(wallet(20, [visit('ifs'), visit('taikoo')])); result.resolve(issued()); await tick(); assert.match(other.quest.innerHTML, /2\/2/); other.hub.destroy();
});

test('closing or destroying during a transaction never applies its notice to a new dialog session', async () => {
  const pending = deferred(), h = harness({ issueDemo: () => pending.promise }); h.hub.setWalletState(wallet()); h.hub.openCheckin(); h.click('prepare-issue', 'ifs'); h.click('issue');
  h.hub.close(); h.hub.openCheckin('taikoo'); pending.resolve(issued()); await tick(); assert.equal(h.hub.isOpen(), true);
  assert.ok(!h.dialog.innerHTML.includes('10 枚试玩交子已到账')); assert.ok(!h.dialog.innerHTML.includes('merchant-confirm')); assert.match(h.quest.innerHTML, /1\/2/);
  h.hub.destroy(); h.hub.destroy(); h.hub.openCheckin(); assert.equal(h.hub.isOpen(), false);
  const later = deferred(), other = harness({ issueDemo: () => later.promise }); other.hub.setWalletState(wallet()); other.hub.openCheckin(); other.click('prepare-issue', 'ifs'); other.click('issue'); other.hub.destroy();
  const html = other.quest.innerHTML; later.resolve(issued()); await tick(); assert.equal(other.quest.innerHTML, html); assert.equal(other.dialog.isConnected, false);
});

test('navigation closes before opening another feature, disabled controls and hidden confirms do nothing', async () => {
  const h = harness(); h.hub.setWalletState(wallet()); h.hub.openCheckin(); h.click('prepare-issue', 'ifs', { disabled: true }); h.click('issue'); assert.equal(h.calls.length, 0);
  h.click('wallet'); assert.deepEqual(h.navigation.at(-1), { type: 'player', tab: 'wallet', opened: false });
  h.click('prepare-issue', 'ifs'); h.click('issue'); assert.equal(h.calls.length, 0);
  h.hub.openCheckin(); h.click('live'); assert.deepEqual(h.navigation.at(-1), { type: 'planner', tab: 'live', opened: false });
  h.hub.openCheckin(); h.click('focus', 'ifs'); assert.equal(h.navigation.at(-1).opened, false); assert.equal(h.navigation.at(-1).merchant.id, 'ifs');
  h.hub.openCheckin(); const event = new Event('cancel', { cancelable: true }); h.dialog.dispatchEvent(event); assert.equal(event.defaultPrevented, true); assert.equal(h.hub.isOpen(), false); h.hub.destroy();
});
