import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as T from '../assets/vendor/three.module.js';

// Exercise the actual controller and OrbitControls with a renderer substitute.
// This checks events, camera math and the real iframe message protocol; it does
// not validate WebGL pixels, FPS, camera hardware or the child app's database.
test('3D entry coordinates exploration, avatar, player and the one shared merchant wallet', async () => {
  let doc;
  const gradient = { addColorStop() {} }, ctx = { fillRect() {}, clearRect() {}, strokeRect() {}, fillText() {}, beginPath() {}, moveTo() {}, ellipse() {}, arc() {}, roundRect() {}, fill() {}, stroke() {}, createLinearGradient: () => gradient, createRadialGradient: () => gradient };
  class Element {
    constructor(tag = 'div') {
      Object.assign(this, { tag, hidden: false, value: '', children: [], dataset: {}, clientWidth: 1000, clientHeight: 700, listeners: new Map(), attributes: new Map(), isConnected: true });
      if (tag === 'iframe') this.contentWindow = { messages: [], postMessage(message, origin) { this.messages.push({ message, origin }); } };
      this.style = { setProperty() {} }; this.classes = new Set();
      this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
    trigger(type, event = {}) { for (const fn of [...this.listeners.get(type) || []]) fn({ target: this, preventDefault() {}, stopPropagation() {}, button: 0, ...event }); }
    setAttribute(k, v) { this.attributes.set(k, v); }
    append(...children) { for (const child of children) { child.parentNode = this; child.isConnected = true; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; this.isConnected = false; }
    querySelectorAll() { return this.children; }
    set innerHTML(markup) {
      this.markup = markup;
      this.replaceChildren(...[...markup.matchAll(/<(\w+)([^>]*)>/g)].filter(m => m[1] === 'form' || /data-(avatar|player-action|game-action)="|class="poi-icon"/.test(m[2])).map(m => {
        const child = new Element(m[1]); child.disabled = /\bdisabled\b/.test(m[2]);
        for (const attr of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
          child.attributes.set(attr[1], attr[2]);
          if (attr[1].startsWith('data-')) child.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = attr[2];
        }
        child.avatarKey = child.dataset.avatar; return child;
      }));
    }
    get innerHTML() { return this.markup || ''; }
    matches(selector) { const data = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); return data ? this.attributes.has(data[1]) && (data[2] === undefined || this.attributes.get(data[1]) === data[2]) : selector.startsWith('.') ? String(this.className || this.attributes.get('class') || '').split(/\s+/).includes(selector.slice(1)) : this.tag === selector; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
    querySelector(selector) { return this.children.find(child => child.matches(selector)); }
    getRootNode() { return doc; }
    getContext() { return ctx; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 }; }
    focus() { if (doc) doc.activeElement = this; } setPointerCapture() {} releasePointerCapture() {}
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const html = await readFile(new URL('../baidu-map.html', import.meta.url), 'utf8'), elements = new Map();
  for (const match of html.matchAll(/<(\w+)\s+[^>]*id="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]); element.hidden = /\bhidden\b/.test(match[0]); elements.set(match[2], element);
  }
  elements.get('scale-bar').append(new Element('i')); elements.get('quality').value = 'high';
  for (const category of ['all', 'food', 'shopping', 'landmark', 'metro']) { const b = new Element('button'); b.dataset.category = category; elements.get('filters').append(b); }
  doc = Object.assign(new Element(), { body: new Element('body'), baseURI: 'http://127.0.0.1:8765/baidu-map.html', getElementById: id => elements.get(id), createElement: tag => new Element(tag) });
  const source = {
    metadata: { coordinate_system: 'WGS84', requested_bbox_wgs84: [104.07, 30.65, 104.08, 30.66] },
    features: [
      { geometry: { type: 'Polygon', coordinates: [[[104.074, 30.654], [104.076, 30.654], [104.076, 30.656], [104.074, 30.656], [104.074, 30.654]]] }, properties: { kind: 'building', osm_id: 12, osm_type: 'way', name: '测试商场', height_m: 15 } },
      { geometry: { type: 'Point', coordinates: [104.075, 30.655] }, properties: { kind: 'poi', uid: 'poi', name: '春熙路步行街', source: 'Baidu', source_crs: 'BD09LL', source_coordinates: [104.084, 30.658], address: '测试地址' } },
      { geometry: { type: 'Point', coordinates: [104.0751, 30.655] }, properties: { kind: 'poi', uid: '615aa960444f34a7283a9f19', name: '成都IFS国际金融中心', source: 'Baidu' } },
      { geometry: { type: 'Point', coordinates: [104.077, 30.656] }, properties: { kind: 'poi', uid: '762ecc492eebc3b816c905f8', name: '成都太古里-西出入口', source: 'Baidu' } },
      { geometry: { type: 'Point', coordinates: [104.073, 30.6533] }, properties: { kind: 'poi', uid: 'walk-stop', name: '沿街咖啡', source: 'Baidu' } },
      { geometry: { type: 'Point', coordinates: [104.073, 30.6564] }, properties: { kind: 'poi', uid: 'walk-preview', name: '下一站书店', source: 'Baidu' } },
    ],
  };
  const route = { available: true, name: 'test walk', coordinateSystem: 'WGS84', coordinates: [[104.073, 30.653], [104.073, 30.657]] };
  const frames = [], stored = new Map(); let time = 0, failStorage = false;
  const replacements = {
    document: doc, window: Object.assign(new Element(), { document: doc, location: { origin: 'http://127.0.0.1:8765' }, devicePixelRatio: 2 }),
    localStorage: { getItem: key => stored.get(key) || null, setItem(key, value) { if (failStorage) throw new Error('Storage unavailable'); stored.set(key, value); } }, ResizeObserver: class { observe() {} },
    performance: { now: () => time }, requestAnimationFrame: fn => frames.push(fn),
    fetch: async path => ({ ok: true, json: async () => path.endsWith('scene.geojson') ? source : route }),
  };
  const originals = new Map(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  replacements.window.localStorage = replacements.localStorage;
  const tick = (delta = 16) => { time += delta; const tasks = frames.splice(0); tasks.forEach(fn => fn(time)); };
  const flush = () => new Promise(setImmediate);
  let demo;
  try {
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const three = new URL('../assets/vendor/three.module.js', import.meta.url).href;
    const substitute = `export * from ${JSON.stringify(three)}; export class WebGLRenderer {
      constructor() { this.shadowMap = {}; this.capabilities = { getMaxAnisotropy: () => 8 }; this.info = { render: { triangles: 0, calls: 0 } }; }
      setPixelRatio() {} setSize() {} render(scene) { scene.updateMatrixWorld(true); }
    }`;
    let controller = await readFile(new URL('../game-map.mjs', import.meta.url), 'utf8');
    controller = controller.replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, new URL('../game-map.mjs', import.meta.url)).href}'`)
      .replace(`from '${three}'`, `from 'data:text/javascript;base64,${Buffer.from(substitute).toString('base64')}'`);
    await import(`data:text/javascript;base64,${Buffer.from(controller + '\n//# sourceURL=map-controller-under-test.mjs').toString('base64')}`);
    for (let i = 0; i < 8 && !window.gameMapDemo; i++) { await new Promise(setImmediate); tick(); }
    demo = window.gameMapDemo; assert.ok(demo, 'controller must start without a DOM or event error');
    const frame = elements.get('jiaozi-frame-container').children[0];
    assert.ok(frame, 'the shared wallet should initialize without opening the collection modal');
    const fromFrame = data => window.trigger('message', { origin: window.location.origin, source: frame.contentWindow, data: { channel: 'jiaozi-map:v1', ...data } });
    const requests = action => frame.contentWindow.messages.map(item => item.message).filter(message => message.type === 'request' && (!action || message.action === action));
    const acknowledged = new Set();
    let wallet = { demo: true, sample: false, wallet: { balance: 30, earned: 30 }, claims: [], merchantCheckins: [], ledger: [], journeys: [], redemptions: [], gifts: [{ id: 'gift-charm', title: '春熙小挂件', cost: 20, symbol: '✦' }] };
    const respond = (rpc, result = wallet) => { assert.ok(rpc, 'expected an outgoing iframe request'); acknowledged.add(rpc.requestId); fromFrame({ type: 'response', requestId: rpc.requestId, ok: true, result }); };
    const settleReads = async () => {
      for (let i = 0; i < 4; i++) { await flush(); for (const rpc of requests().filter(item => ['initialize', 'get-player-state'].includes(item.action) && !acknowledged.has(item.requestId))) respond(rpc); }
    };
    fromFrame({ type: 'ready' });
    const bootstrap = requests('initialize')[0];
    assert.deepEqual(bootstrap.payload.merchants.map(item => item.placeId), ['615aa960444f34a7283a9f19', '762ecc492eebc3b816c905f8'], 'only stations backed by real map POIs enter the shared registry');
    respond(bootstrap); await settleReads();
    const playerCard = elements.get('stage').children.find(element => element.id === 'map-player-card');
    const playerDialog = doc.body.children.find(element => element.id === 'map-player-center');
    const merchantDialog = doc.body.children.find(element => element.id === 'map-merchant-center');
    const quest = elements.get('stage').children.find(element => element.className === 'game-quest');
    const delegated = (root, key, action, data = {}) => {
      const button = root.children.find(element => element.dataset[key] === action && Object.entries(data).every(([name, value]) => element.dataset[name] === value));
      assert.ok(button, `missing rendered ${key}=${action}`); assert.equal(button.disabled, false, `${action} must be usable`);
      root.trigger('click', { target: button });
    };
    const playerClick = (action, data) => delegated(playerDialog, 'playerAction', action, data);
    const merchantClick = (action, data) => delegated(merchantDialog, 'gameAction', action, data);
    assert.match(playerCard.innerHTML, /<b>30<\/b>/); assert.match(quest.innerHTML, /0\/2/);
    assert.equal(elements.get('loading').hidden, true); const perspective = demo.camera;
    const elevation = () => {
      const offset = demo.camera.position.clone().sub(demo.controls.target);
      return Math.atan2(offset.y, Math.hypot(offset.x, offset.z)) * 180 / Math.PI;
    };
    assert.ok(elevation() > 39, 'initial bird view must look down from a raised camera');
    // Categories are also the discovery-list entry point after removing the
    // duplicate places button. Switching categories must update the open list.
    const filters = elements.get('filters').children;
    const filter = category => filters.find(button => button.dataset.category === category);
    filter('all').trigger('click');
    assert.equal(elements.get('place-panel').hidden, false);
    assert.equal(filter('all').attributes.get('aria-expanded'), 'true');
    assert.ok(elements.get('place-list').children.some(row => row.textContent.includes('沿街咖啡')));
    assert.ok(elements.get('place-list').children.some(row => row.textContent.includes('成都IFS')));
    filter('food').trigger('click');
    assert.equal(filter('all').attributes.get('aria-expanded'), 'false');
    assert.equal(filter('food').attributes.get('aria-expanded'), 'true');
    assert.deepEqual(elements.get('place-list').children.map(row => row.textContent), ['沿街咖啡']);
    elements.get('toggle-map-categories').trigger('click');
    assert.equal(elements.get('filters').hidden, true);
    assert.equal(elements.get('place-panel').hidden, false, 'folding categories keeps the current results open');
    elements.get('toggle-map-categories').trigger('click');
    assert.equal(elements.get('filters').hidden, false);
    assert.equal(filter('food').attributes.get('aria-pressed'), 'true', 'unfolding preserves the selected category');
    elements.get('place-list').children[0].trigger('click');
    assert.equal(demo.state().selected, 'walk-stop');
    assert.equal(elements.get('place-panel').hidden, true);
    assert.ok(filters.every(button => button.attributes.get('aria-expanded') === 'false'));
    elements.get('close-selection').trigger('click');
    filter('all').trigger('click');
    elements.get('close-places').trigger('click');
    assert.equal(elements.get('place-panel').hidden, true);
    assert.ok(filters.every(button => button.attributes.get('aria-expanded') === 'false'));
    elements.get('view-plan').trigger('click'); tick();
    assert.ok(demo.camera.isOrthographicCamera); assert.equal(demo.controls.enableRotate, false);
    assert.equal(demo.state().mode, 'plan');
    assert.equal(demo.camera.near, .5, 'orthographic view retains its linear depth precision');
    const north = new T.Vector3(0, 0, -100).project(demo.camera), south = new T.Vector3(0, 0, 100).project(demo.camera);
    assert.ok(north.y > south.y, 'actual OrbitControls camera must keep north at the top');
    elements.get('zoom-in').trigger('click'); const zoom = demo.camera.zoom; assert.ok(zoom > 1);
    // A real ray through the building interior must select the flat plan footprint.
    const p = new T.Vector3(20, 0, 20).project(demo.camera), canvas = elements.get('scene-canvas');
    const pointer = { pointerType: 'mouse', pointerId: 1, clientX: (p.x + 1) * 500, clientY: (1 - p.y) * 350, ctrlKey: false, metaKey: false, shiftKey: false };
    canvas.trigger('pointerdown', pointer); canvas.trigger('pointerup', pointer); tick();
    assert.equal(demo.state().selected, 'way-12-0'); assert.equal(elements.get('selection').hidden, false);
    assert.match(elements.get('compare-location').href, /openstreetmap.org\/way\/12/);
    elements.get('markers').children[0].trigger('click');
    assert.match(elements.get('compare-location').href, /api.map.baidu.com\/marker/);
    elements.get('play-route').trigger('click'); tick();
    assert.equal(demo.camera, perspective); assert.equal(demo.state().mode, 'street');
    assert.equal(demo.state().walking, true); assert.ok(demo.state().walkDistance > 0);
    elements.get('toggle-map-tools').trigger('click');
    assert.equal(elements.get('map-tool-actions').hidden, true);
    assert.equal(demo.state().walking, true, 'folding tools does not interrupt the active cruise');
    elements.get('toggle-map-tools').trigger('click');
    assert.equal(elements.get('map-tool-actions').hidden, false);
    elements.get('discovery-stops').checked = true;
    for (let i = 0; i < 200 && demo.state().walking; i++) tick(50);
    assert.equal(demo.state().selected, 'walk-stop', 'cruise must stop at an unlit place along the actual route');
    assert.equal(demo.state().walking, false);
    elements.get('visit').trigger('click'); tick();
    assert.ok(demo.state().visited.includes('walk-stop'));
    assert.ok(JSON.parse(stored.get('jiaozi-chunxi-3d-v1')).includes('walk-stop'), 'explicit lighting must persist for the next page load');
    const memory = demo.district.root.children.find(c => c.name === 'exploration-landmarks');
    assert.ok(memory.children.some(c => c.userData.placeId === 'walk-stop'), 'lighting must change the actual 3D scene');
    elements.get('resume-route').trigger('click'); tick(); assert.equal(demo.state().walking, true);
    // Opening the complete souvenir app pauses the actual route controller and
    // blocks input. Closing preserves its iframe instead of losing photo edits.
    elements.get('open-jiaozi').trigger('click'); tick();
    assert.equal(demo.jiaozi.isOpen(), true); assert.equal(demo.state().walking, false);
    assert.equal(demo.controls.enabled, false);
    const position = demo.camera.position.toArray(), beforeDistance = demo.state().walkDistance;
    elements.get('viewport').trigger('keydown', { key: 'ArrowUp', target: { closest: () => false } }); tick();
    assert.deepEqual(demo.camera.position.toArray(), position); assert.equal(demo.state().walkDistance, beforeDistance);
    const request = (requestId, action, payload) => fromFrame({ type: 'request', requestId, action, payload });
    request('route-snapshot', 'get-route'); await new Promise(setImmediate);
    const snapshot = frame.contentWindow.messages.find(m => m.message.requestId === 'route-snapshot').message.result;
    assert.equal(snapshot.source, 'demo'); assert.match(snapshot.description, /不是实际 GPS/);
    request('other-route', 'navigate-route', { routeId: 'six-landmark-sample' }); await new Promise(setImmediate);
    assert.equal(demo.jiaozi.isOpen(), true, 'an unrelated saved journey must not open a different Chunxi route');
    assert.equal(frame.contentWindow.messages.find(m => m.message.requestId === 'other-route').message.ok, false);
    request('outside', 'navigate-place', { id: 'landmark-04' }); await new Promise(setImmediate);
    assert.equal(demo.jiaozi.isOpen(), true, 'an out-of-bounds temple must not be placed inside Chunxi');
    assert.equal(frame.contentWindow.messages.find(m => m.message.requestId === 'outside').message.ok, false);
    request('ifs', 'navigate-place', { id: 'landmark-01' }); await new Promise(setImmediate);
    assert.equal(demo.jiaozi.isOpen(), false); assert.equal(demo.state().selected, '615aa960444f34a7283a9f19'); assert.equal(demo.controls.enabled, true);
    elements.get('open-jiaozi').trigger('click'); assert.equal(elements.get('jiaozi-frame-container').children[0], frame);
    request('chunxi-route', 'navigate-route', { routeId: snapshot.id }); await new Promise(setImmediate);
    assert.equal(frame.contentWindow.messages.find(m => m.message.requestId === 'chunxi-route').message.ok, true);
    assert.equal(demo.jiaozi.isOpen(), false); assert.equal(elements.get('route-panel').hidden, false);
    elements.get('play-route').trigger('click');
    for (let i = 0; i < 130; i++) tick(50);
    assert.equal(demo.state().walking, true, 'a replay must pass the lit station without pausing');
    assert.ok(demo.state().walkDistance > 35);
    elements.get('open-jiaozi').trigger('click');
    elements.get('close-jiaozi').trigger('click');
    elements.get('play-route').trigger('click'); assert.equal(demo.state().walking, true);
    elements.get('play-route').trigger('click'); assert.equal(demo.state().walking, false);
    const previewDistance = demo.state().walkDistance, previewAvatar = demo.state().avatar;
    elements.get('next-discovery').trigger('click');
    assert.equal(demo.state().selected, 'walk-preview'); assert.equal(elements.get('resume-route').hidden, false);
    assert.equal(demo.state().walkDistance, previewDistance); assert.deepEqual(demo.state().avatar, previewAvatar, 'preview must not teleport the character');
    failStorage = true;
    elements.get('visit').trigger('click');
    assert.equal(elements.get('resume-route').hidden, false, 'lighting a manually previewed stop must retain the continue action');
    assert.match(elements.get('status').textContent, /仅本次打开有效/);
    assert.ok(demo.state().visited.includes('walk-preview'), 'storage failure must retain this session exploration');
    assert.ok(!JSON.parse(stored.get('jiaozi-chunxi-3d-v1')).includes('walk-preview'));
    failStorage = false;
    elements.get('view-street').trigger('click');
    for (let i = 0; i < 60; i++) tick();
    assert.ok(elevation() > 30, 'forward roaming must use the raised viewpoint');
    elements.get('view-overview').trigger('click');
    for (let i = 0; i < 60; i++) tick();
    assert.ok(elevation() > 49, 'overview button must use the raised viewpoint');
    assert.ok(demo.camera.near > 1, 'overview must use the adaptive precision projection');
    // A complete character edit pauses the same controller as the other apps,
    // updates the actual scene material, and persists without moving the avatar.
    elements.get('play-route').trigger('click'); tick();
    elements.get('customize-avatar').trigger('click'); tick();
    assert.equal(demo.avatarEditor.isOpen(), true); assert.equal(demo.controls.enabled, false); assert.equal(demo.state().walking, false);
    const dialog = doc.body.children.find(e => e.id === 'map-avatar-editor');
    const field = key => dialog.querySelector(`[data-avatar="${key}"]`);
    const mapPosition = demo.state().avatar, originalOutfit = demo.district.avatar.getObjectByName('jacket').material.color.getHexString();
    field('outfitColor').value = '#317c96'; field('outfitColor').trigger('input');
    field('cancel').trigger('click'); tick();
    assert.equal(demo.district.avatar.getObjectByName('jacket').material.color.getHexString(), originalOutfit, 'cancel must leave the map avatar unchanged');
    elements.get('customize-avatar').trigger('click');
    field('outfitColor').value = '#317c96'; field('outfitColor').trigger('input');
    dialog.querySelector('form').trigger('submit'); tick();
    assert.equal(demo.avatarEditor.isOpen(), false); assert.equal(demo.controls.enabled, true);
    assert.equal(demo.district.avatar.getObjectByName('jacket').material.color.getHexString(), '317c96');
    assert.equal(JSON.parse(stored.get('jiaozi-map-avatar-v1')).outfitColor, '#317c96');
    assert.deepEqual(demo.state().avatar, mapPosition, 'customizing appearance must preserve the geographic position');
    assert.equal(elements.get('customize-avatar').attributes.get('aria-expanded'), 'false');
    // Player -> appearance is a sibling-modal handoff. The destination remains
    // locked even though closing the source briefly calls resumeFromModal.
    elements.get('play-route').trigger('click'); tick(); assert.equal(demo.state().walking, true);
    playerCard.trigger('click'); await settleReads();
    assert.equal(demo.player.isOpen(), true); assert.equal(demo.state().walking, false); assert.equal(demo.controls.enabled, false);
    playerClick('open-avatar'); await flush(); tick();
    assert.equal(demo.player.isOpen(), false); assert.equal(demo.avatarEditor.isOpen(), true); assert.equal(demo.controls.enabled, false);
    const lockedPosition = demo.state().avatar;
    elements.get('viewport').trigger('keydown', { key: 'ArrowUp', target: { closest: () => false } }); tick();
    assert.deepEqual(demo.state().avatar, lockedPosition, 'the handoff must not leak movement into the new modal');
    field('cancel').trigger('click'); assert.equal(demo.controls.enabled, true); assert.equal(demo.state().walking, false, 'closing appearance must not restart the old route automatically');

    // Lighting and simulated movement are map exploration, never a merchant
    // transaction. Inspect the actual iframe protocol rather than a UI counter.
    assert.equal(requests('demo-checkin').length, 0); assert.equal(requests('redeem').length, 0);
    request('ifs-for-merchant', 'navigate-place', { id: 'landmark-01' }); await flush();
    assert.equal(elements.get('merchant-checkin').hidden, false);
    const avatarBeforeMove = demo.state().avatar;
    elements.get('move-avatar').trigger('click'); tick();
    assert.notDeepEqual(demo.state().avatar, avatarBeforeMove); assert.equal(requests('demo-checkin').length, 0);
    assert.match(playerCard.innerHTML, /<b>30<\/b>/); assert.match(quest.innerHTML, /0\/2/);
    elements.get('merchant-checkin').trigger('click'); await settleReads();
    assert.equal(demo.gameHub.isOpen(), true); assert.equal(demo.controls.enabled, false);
    assert.match(merchantDialog.innerHTML, /IFS 探索站/); assert.match(merchantDialog.innerHTML, /太古里西入口探索站/);
    assert.ok(!merchantDialog.innerHTML.includes('烤匠 IFS 体验站'), 'missing source POIs cannot become fictitious stations');
    merchantClick('station', { merchant: 'chunxi-taikoo' });
    assert.match(merchantDialog.innerHTML, /<h3>太古里西入口探索站<\/h3>/);
    merchantClick('focus', { merchant: 'chunxi-taikoo' });
    assert.equal(demo.gameHub.isOpen(), false); assert.equal(demo.state().selected, '762ecc492eebc3b816c905f8');
    elements.get('merchant-checkin').trigger('click'); await settleReads();
    merchantClick('prepare-issue', { merchant: 'chunxi-taikoo' }); assert.equal(requests('demo-checkin').length, 0, 'previewing issuance must not mutate the wallet');
    merchantClick('issue'); await flush();
    const checkin = requests('demo-checkin')[0]; assert.equal(checkin.payload.merchantId, 'chunxi-taikoo');
    assert.equal(checkin.payload.source, 'demo'); assert.ok(checkin.payload.eventId.length > 5); assert.equal(checkin.payload.routeId, undefined, 'a cached map preview cannot invent an active personalized journey');
    assert.match(playerCard.innerHTML, /<b>30<\/b>/, 'the controller must wait for the authoritative shared wallet');
    const now = new Date(), day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    wallet = { ...wallet, wallet: { balance: 40, earned: 40 }, merchantCheckins: [{ id: 'merchant-event-1', merchantId: 'chunxi-taikoo', placeName: '成都太古里-西出入口', day, occurredAt: now.toISOString(), source: 'demo', amount: 10 }], ledger: [{ id: 'earn-1', kind: 'earn', amount: 10, title: '太古里体验站发放', createdAt: now.toISOString() }] };
    respond(checkin); await settleReads();
    assert.match(playerCard.innerHTML, /<b>40<\/b>/); assert.match(playerCard.innerHTML, /1 次到访/); assert.match(quest.innerHTML, /1\/2/);
    assert.match(merchantDialog.innerHTML, /今日已领取/); assert.match(elements.get('jiaozi-points').textContent, /40 交子/);
    const disabledIssue = merchantDialog.children.find(element => element.dataset.gameAction === 'prepare-issue' && element.dataset.merchant === 'chunxi-taikoo');
    assert.equal(disabledIssue.disabled, true, 'same-day state must disable duplicate issuance');

    merchantClick('gifts'); await settleReads();
    assert.equal(demo.gameHub.isOpen(), false); assert.equal(demo.player.isOpen(), true); assert.equal(demo.controls.enabled, false);
    assert.match(playerDialog.innerHTML, /试玩钱包 · 不用于线下结算/);
    playerClick('select-gift', { playerGift: 'gift-charm' }); assert.equal(requests('redeem').length, 0);
    playerClick('confirm-gift'); await flush();
    const redeem = requests('redeem')[0]; assert.equal(redeem.payload.giftId, 'gift-charm'); assert.ok(redeem.payload.requestId.length > 5);
    assert.match(playerCard.innerHTML, /<b>40<\/b>/, 'gift selection cannot deduct a private player balance');
    const order = { id: 'shared-order-1', giftId: 'gift-charm', title: '春熙小挂件', cost: 20, status: 'pending', createdAt: now.toISOString() };
    wallet = { ...wallet, wallet: { balance: 20, earned: 40 }, redemptions: [order], ledger: [...wallet.ledger, { id: 'spend-1', kind: 'spend', amount: -20, title: '兑换春熙小挂件', createdAt: now.toISOString() }] };
    respond(redeem); await settleReads();
    assert.match(playerCard.innerHTML, /<b>20<\/b>/); assert.match(playerDialog.innerHTML, /待领取 · 试玩/);
    assert.match(elements.get('jiaozi-points').textContent, /20 交子/); assert.match(quest.innerHTML, /1\/2/);
    playerClick('select-cancel-order', { playerOrder: order.id }); assert.equal(requests('cancel-redemption').length, 0);
    playerClick('confirm-cancel-order'); await flush();
    const cancel = requests('cancel-redemption')[0]; assert.deepEqual(cancel.payload, { id: order.id });
    wallet = { ...wallet, wallet: { balance: 40, earned: 40 }, redemptions: [{ ...order, status: 'cancelled' }] }; respond(cancel); await settleReads();
    assert.match(playerCard.innerHTML, /<b>40<\/b>/); assert.match(playerDialog.innerHTML, /已取消并退回交子/);
    // Mutations from the full collection app push into both map surfaces, not
    // only into the component that originally sent a command.
    const remoteOrder = { ...order, id: 'shared-order-from-collection' };
    wallet = { ...wallet, wallet: { balance: 30, earned: 50 }, redemptions: [...wallet.redemptions, remoteOrder], merchantCheckins: [...wallet.merchantCheckins, { id: 'merchant-event-2', merchantId: 'chunxi-ifs', placeName: '成都IFS国际金融中心', day, occurredAt: now.toISOString(), source: 'demo', amount: 10 }] };
    fromFrame({ type: 'state', state: wallet, wallet: wallet.wallet }); await flush();
    assert.match(playerCard.innerHTML, /<b>30<\/b>/); assert.match(playerCard.innerHTML, /2 次到访/); assert.match(quest.innerHTML, /2\/2/);
    assert.match(elements.get('jiaozi-points').textContent, /30 交子/);
    playerClick('receive-order', { playerOrder: remoteOrder.id }); await flush();
    const receipt = requests('receive-demo-redemption')[0]; assert.deepEqual(receipt.payload, { id: remoteOrder.id });
    wallet = { ...wallet, redemptions: wallet.redemptions.map(item => item.id === remoteOrder.id ? { ...item, status: 'received' } : item) }; respond(receipt); await settleReads();
    assert.match(playerDialog.innerHTML, /已试玩领取/); assert.match(playerCard.innerHTML, /<b>30<\/b>/, 'receiving an existing order must not spend again');
    playerClick('tab-visits'); assert.match(playerDialog.innerHTML, /成都太古里-西出入口/); assert.match(playerDialog.innerHTML, /商家打卡/);
    playerClick('open-checkin'); await settleReads(); assert.equal(demo.player.isOpen(), false); assert.equal(demo.gameHub.isOpen(), true); assert.equal(demo.controls.enabled, false);
    merchantClick('close'); assert.equal(demo.controls.enabled, true);
    assert.equal(requests('demo-checkin').length, 1, 'moving, lighting, opening records and switching modals cannot mint more checkins');
    assert.equal(requests().filter(item => !acknowledged.has(item.requestId)).length, 0, 'all shared-wallet calls must settle before teardown');
    for (let i = 0; i < 3; i++) { elements.get('view-plan').trigger('click'); elements.get('view-overview').trigger('click'); }
    assert.equal((canvas.listeners.get('wheel') || []).length, 1, 'switching cameras must dispose old controls');
  } finally {
    // Eager initialization creates RPC timeout handles even when the collection
    // never opens. Dispose first, while the original test DOM still exists.
    demo?.jiaozi.destroy(); demo?.player.destroy(); demo?.gameHub.destroy(); demo?.avatarEditor.destroy();
    await flush();
    for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});
