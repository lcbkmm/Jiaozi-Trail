import test from 'node:test';
import assert from 'node:assert/strict';
import { JIAOZI_CHANNEL, setupMapJiaozi } from '../game-map-jiaozi.mjs';

// A small DOM harness exercises the bridge's actual event and lifecycle code.
class Element extends EventTarget {
  constructor(id, doc) { super(); this.id = id; this.doc = doc; this.attributes = {}; this.hidden = false; this.isConnected = true; this.children = []; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(node) { this.children.push(node); }
  remove() { this.isConnected = false; }
  focus() { this.doc.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function harness(options = {}) {
  const host = new EventTarget();
  host.location = { origin: 'http://127.0.0.1:8765' };
  const doc = { baseURI: 'http://127.0.0.1:8765/baidu-map.html' };
  const nodes = new Map(['jiaozi-panel', 'open-jiaozi', 'close-jiaozi', 'jiaozi-frame-container', 'jiaozi-load-status', 'jiaozi-points', 'viewport'].map(id => [id, new Element(id, doc)]));
  const sent = [];
  doc.getElementById = id => nodes.get(id);
  doc.activeElement = nodes.get('viewport');
  doc.createElement = type => {
    assert.equal(type, 'iframe');
    const frame = new Element('jiaozi-frame', doc);
    frame.contentWindow = { postMessage: (message, origin) => sent.push({ ...message, origin }) };
    return frame;
  };
  host.document = doc;
  const bridge = setupMapJiaozi({ ...options, host });
  const frame = () => nodes.get('jiaozi-frame-container').children[0];
  async function receive(data, overrides = {}) {
    const event = new Event('message');
    Object.assign(event, { origin: host.location.origin, source: frame()?.contentWindow, data: { channel: JIAOZI_CHANNEL, ...data }, ...overrides });
    host.dispatchEvent(event);
    await new Promise(resolve => setImmediate(resolve));
  }
  return { bridge, host, doc, nodes, sent, frame, receive };
}
const playerState = balance => ({ wallet: { balance, earned: 30 }, claims: [], merchantCheckins: [], gifts: [], sample: false, demo: true });
async function initializeWallet(h, balance = 0) {
  await h.receive({ type: 'ready', state: playerState(balance) });
  const init = h.sent.find(m => m.type === 'request' && m.action === 'initialize');
  await h.receive({ type: 'response', requestId: init.requestId, ok: true, result: playerState(balance) });
  await h.bridge.initialize();
}

test('eager same-origin wallet initialization preserves the whole app and editor between closes', async () => {
  let opens = 0, closes = 0;
  const h = harness({ onOpen: () => opens++, onClose: () => closes++ });
  assert.ok(h.frame()); assert.equal(h.bridge.isOpen(), false);
  h.bridge.open('photos');
  const first = h.frame();
  assert.equal(new URL(first.src).origin, h.host.location.origin);
  assert.match(first.src, /assets\/digital-jiaozi\/index.html#\/digital-jiaozi$/);
  assert.equal(h.bridge.isOpen(), true);
  await h.receive({ type: 'ready', wallet: { balance: 20 }, sample: false });
  assert.equal(h.sent.filter(m => m.type === 'navigate').at(-1).view, 'photos');
  h.bridge.close();
  assert.equal(h.doc.activeElement, h.nodes.get('viewport'));
  h.bridge.open();
  assert.equal(h.frame(), first);
  assert.equal(h.sent.filter(m => m.type === 'navigate').length, 1, 'reopen must not reset the active page');
  assert.equal(opens, 2); assert.equal(closes, 1);
  h.bridge.destroy();
  assert.equal(first.isConnected, false);
  h.bridge.open(); assert.equal(h.bridge.isOpen(), false);
});

test('messages require both the exact same origin and the paired iframe', async () => {
  const h = harness(); h.bridge.open();
  await h.receive({ type: 'ready', wallet: { balance: 999 } }, { origin: 'https://other.example' });
  await h.receive({ type: 'ready', wallet: { balance: 999 } }, { source: {} });
  assert.equal(h.nodes.get('jiaozi-points').textContent, '');
  await h.receive({ type: 'ready', wallet: { balance: 10 }, sample: false });
  assert.equal(h.nodes.get('jiaozi-points').textContent, '10 交子 · 试玩');
  await h.receive({ type: 'state', wallet: { balance: 60 }, sample: true });
  assert.equal(h.nodes.get('jiaozi-points').textContent, '10 交子 · 试玩');
  await h.receive({ type: 'state', wallet: { balance: -1 } });
  assert.equal(h.nodes.get('jiaozi-points').textContent, '10 交子 · 试玩');
  h.bridge.destroy();
});

test('route snapshot is returned intact and does not pretend to be a GPS check-in', async () => {
  const route = { id: 'chunxi-demo', title: '春熙路步行探索', source: 'demo', places: [{ id: 'ifs', name: 'IFS' }] };
  const h = harness({ getRouteSnapshot: async () => route }); h.bridge.open();
  await h.receive({ type: 'request', requestId: 'route-1', action: 'get-route' });
  assert.deepEqual(h.sent.at(-1).result, route);
  assert.equal(h.sent.at(-1).ok, true);
  assert.equal(h.bridge.isOpen(), true);
  assert.equal('acceptCheckin' in h.bridge, false);
  h.bridge.destroy();
});

test('viewing an available landmark closes the app, out-of-range landmarks retain it and receive feedback', async () => {
  const seen = [];
  const h = harness({ navigateToPlace: async landmark => { seen.push(landmark); return landmark.id === 'landmark-01'; } });
  h.bridge.open('collection');
  await h.receive({ type: 'request', requestId: 'outside', action: 'navigate-place', payload: { id: 'landmark-04', name: 'untrusted name', placeId: 'fabricated' } });
  assert.equal(h.bridge.isOpen(), true);
  assert.match(h.sent.at(-1).error, /不在当前春熙路板块/);
  assert.deepEqual(seen[0], { id: 'landmark-04', name: '大慈寺', placeId: null });
  await h.receive({ type: 'request', requestId: 'inside', action: 'navigate-place', payload: { id: 'landmark-01' } });
  assert.equal(h.sent.at(-1).ok, true); assert.equal(h.bridge.isOpen(), false);
  h.bridge.destroy();
});

test('explicit navigation queues until the frame is ready; reload sync does not reset it', async () => {
  const h = harness(); h.bridge.open('journey');
  assert.equal(h.sent.some(m => m.type === 'navigate'), false);
  await h.receive({ type: 'ready', wallet: { balance: 0 } });
  assert.equal(h.sent.filter(m => m.type === 'navigate').length, 1);
  h.frame().dispatchEvent(new Event('load'));
  await h.receive({ type: 'ready', wallet: { balance: 0 }, sample: true });
  assert.equal(h.sent.filter(m => m.type === 'navigate').length, 1);
  assert.equal(h.sent.at(-1).type, 'sync');
  h.bridge.destroy();
});

test('failed routes and unknown RPCs report errors; teardown ignores late messages', async () => {
  const h = harness({ navigateToRoute: async () => false }); h.bridge.open();
  await h.receive({ type: 'request', requestId: 'no-route', action: 'navigate-route' });
  assert.equal(h.sent.at(-1).ok, false); assert.equal(h.bridge.isOpen(), true);
  await h.receive({ type: 'request', requestId: 'unknown', action: 'accept-checkin' });
  assert.equal(h.sent.at(-1).ok, false);
  h.bridge.destroy(); const count = h.sent.length;
  await h.receive({ type: 'request', requestId: 'late', action: 'get-route' });
  assert.equal(h.sent.length, count);
});

test('map check-in and redemption commands share a configured wallet and never import example balances', async () => {
  const seen = [], merchants = [{ id: 'chunxi-ifs', name: 'IFS 探索站', placeId: 'actual-ifs', landmarkId: 'landmark-01' }];
  const h = harness({ merchants, onState: state => seen.push(state) });
  const state = balance => ({ wallet: { balance, earned: 10 }, claims: [], merchantCheckins: [], gifts: [], sample: false, demo: true });
  await h.receive({ type: 'ready', state: state(0), wallet: { balance: 0 } });
  const init = h.sent.find(m => m.type === 'request' && m.action === 'initialize');
  assert.deepEqual(init.payload.merchants, merchants);
  await h.receive({ type: 'response', requestId: init.requestId, ok: true, result: state(0) });
  assert.equal((await h.bridge.initialize()).wallet.balance, 0);
  const checkin = h.bridge.demoCheckin({ merchantId: 'chunxi-ifs', eventId: 'demo-event' });
  await new Promise(resolve => setImmediate(resolve));
  const issue = h.sent.at(-1); assert.equal(issue.action, 'demo-checkin');
  await h.receive({ type: 'response', requestId: issue.requestId, ok: true, result: state(10) });
  assert.equal((await checkin).wallet.balance, 10); assert.equal(seen.at(-1).wallet.balance, 10);
  await h.receive({ type: 'state', state: { ...state(999), sample: true }, wallet: { balance: 999 }, sample: true });
  assert.equal(seen.at(-1).wallet.balance, 10);
  const redemption = h.bridge.redeem('gift-charm', 'stable-redemption');
  const rejected = assert.rejects(redemption, /可用交子不足/);
  await new Promise(resolve => setImmediate(resolve));
  const spend = h.sent.at(-1); assert.deepEqual(spend.payload, { giftId: 'gift-charm', requestId: 'stable-redemption' });
  await h.receive({ type: 'response', requestId: spend.requestId, ok: false, error: '可用交子不足' });
  await rejected;
  assert.equal(seen.at(-1).wallet.balance, 10); h.bridge.destroy();
});

test('a destroyed bridge rejects in-flight operations and removes state listeners', async () => {
  const h = harness(); const pending = h.bridge.getPlayerState();
  h.bridge.destroy(); await assert.rejects(pending, /交子窗口已关闭/);
  await assert.rejects(h.bridge.getPlayerState(), /交子窗口已关闭/);
});

test('a late initialization snapshot cannot replace a newer full wallet push', async () => {
  const seen = [], h = harness({ onState: state => seen.push(state.wallet.balance) });
  await h.receive({ type: 'ready', state: playerState(0) });
  const init = h.sent.find(m => m.action === 'initialize');
  await h.receive({ type: 'state', state: playerState(20) });
  await h.receive({ type: 'response', requestId: init.requestId, ok: true, result: playerState(0) });
  assert.equal((await h.bridge.initialize()).wallet.balance, 20);
  assert.deepEqual(seen, [0, 20]);
  assert.equal(h.nodes.get('jiaozi-points').textContent, '20 交子 · 试玩');
  // Subsequent initialize calls also expose the current shared state.
  await h.receive({ type: 'state', state: playerState(30) });
  assert.equal((await h.bridge.initialize()).wallet.balance, 30);
  h.bridge.destroy();
});

test('an in-flight read returns the newer pushed state without rolling subscribers or badge back', async () => {
  const seen = [], h = harness({ onState: state => seen.push(state.wallet.balance) });
  await initializeWallet(h);
  const read = h.bridge.getPlayerState();
  await new Promise(resolve => setImmediate(resolve));
  const request = h.sent.at(-1);
  await h.receive({ type: 'state', state: playerState(20) });
  const updates = seen.length;
  await h.receive({ type: 'response', requestId: request.requestId, ok: true, result: playerState(0) });
  assert.equal((await read).wallet.balance, 20);
  assert.equal(seen.length, updates, 'discarded snapshots must not notify UI consumers');
  assert.equal(h.nodes.get('jiaozi-points').textContent, '20 交子 · 试玩');
  h.bridge.destroy();
});

test('reverse RPC completion keeps its own receipt, then reconciles a command that may have committed after the newer read', async () => {
  const seen = [], h = harness({ onState: state => seen.push(state.wallet.balance) });
  await initializeWallet(h, 30);
  const checkin = h.bridge.demoCheckin({ merchantId: 'chunxi-ifs' });
  await new Promise(resolve => setImmediate(resolve));
  const issue = h.sent.at(-1);
  const read = h.bridge.getPlayerState();
  await new Promise(resolve => setImmediate(resolve));
  const newer = h.sent.at(-1);
  await h.receive({ type: 'response', requestId: newer.requestId, ok: true, result: playerState(20) });
  assert.equal((await read).wallet.balance, 20);
  const receipt = { checkin: { id: 'issued-once', amount: 10 }, awarded: true, duplicate: false };
  const updates = seen.length;
  await h.receive({ type: 'response', requestId: issue.requestId, ok: true, result: { ...playerState(40), lastCheckin: receipt } });
  const result = await checkin;
  assert.equal(result.wallet.balance, 20);
  assert.deepEqual(result.lastCheckin, receipt);
  assert.equal(seen.length, updates);
  assert.equal(h.nodes.get('jiaozi-points').textContent, '20 交子 · 试玩');
  const reconciliation = h.sent.at(-1);
  assert.equal(reconciliation.action, 'get-player-state');
  assert.notEqual(reconciliation.requestId, newer.requestId);
  await h.receive({ type: 'response', requestId: reconciliation.requestId, ok: true, result: playerState(40) });
  assert.equal(seen.at(-1), 40, 'a late real mutation must not be lost while preventing snapshot rollback');
  assert.equal(h.nodes.get('jiaozi-points').textContent, '40 交子 · 试玩');
  h.bridge.destroy();
});

test('sample or malformed pushes cannot invalidate a genuine pending response or desynchronize the badge', async () => {
  const h = harness(); await initializeWallet(h);
  const read = h.bridge.getPlayerState();
  await new Promise(resolve => setImmediate(resolve));
  const request = h.sent.at(-1);
  await h.receive({ type: 'state', state: { ...playerState(999), sample: true }, wallet: { balance: 999 }, sample: true });
  await h.receive({ type: 'state', state: { ...playerState(999), demo: false }, wallet: { balance: 999 } });
  assert.equal(h.nodes.get('jiaozi-points').textContent, '0 交子 · 试玩');
  await h.receive({ type: 'response', requestId: request.requestId, ok: true, result: playerState(10) });
  assert.equal((await read).wallet.balance, 10);
  assert.equal(h.nodes.get('jiaozi-points').textContent, '10 交子 · 试玩');
  h.bridge.destroy();
});

test('conflicting writes reconcile serially and repeat the read when another write finishes during it', async () => {
  const h = harness(); await initializeWallet(h, 30);
  const first = h.bridge.demoCheckin({ merchantId: 'chunxi-ifs' });
  const second = h.bridge.redeem('gift-charm', 'redemption-race');
  await new Promise(resolve => setImmediate(resolve));
  const mutations = h.sent.filter(m => m.type === 'request' && ['demo-checkin', 'redeem'].includes(m.action));
  const read = h.bridge.getPlayerState();
  await new Promise(resolve => setImmediate(resolve));
  const newer = h.sent.at(-1);
  await h.receive({ type: 'response', requestId: newer.requestId, ok: true, result: playerState(20) });
  await read;
  await h.receive({ type: 'response', requestId: mutations[0].requestId, ok: true, result: playerState(40) });
  const refresh = h.sent.at(-1), sentBeforeSecond = h.sent.length;
  await h.receive({ type: 'response', requestId: mutations[1].requestId, ok: true, result: playerState(10) });
  await Promise.all([first, second]);
  assert.equal(h.sent.length, sentBeforeSecond, 'the second conflict shares the in-flight refresh');
  await h.receive({ type: 'response', requestId: refresh.requestId, ok: true, result: playerState(40) });
  const finalRead = h.sent.at(-1);
  assert.equal(finalRead.action, 'get-player-state');
  assert.notEqual(finalRead.requestId, refresh.requestId, 'a write completed after the first refresh began');
  await h.receive({ type: 'response', requestId: finalRead.requestId, ok: true, result: playerState(10) });
  assert.equal(h.nodes.get('jiaozi-points').textContent, '10 交子 · 试玩');
  h.bridge.destroy();
});

test('invalid RPC state rejects the command and never exposes the sample archive to its caller', async () => {
  const h = harness(); await initializeWallet(h, 10);
  const read = h.bridge.getPlayerState();
  const rejected = assert.rejects(read, /无效的试玩钱包状态/);
  await new Promise(resolve => setImmediate(resolve));
  const request = h.sent.at(-1);
  await h.receive({ type: 'response', requestId: request.requestId, ok: true, result: { ...playerState(999), sample: true } });
  await rejected;
  assert.equal(h.nodes.get('jiaozi-points').textContent, '10 交子 · 试玩');
  h.bridge.destroy();
});
