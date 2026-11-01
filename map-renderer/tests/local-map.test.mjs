import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMapCamera, validateSceneFiles } from '../local-map-model.mjs';

const bbox = [104.07, 30.65, 104.08, 30.66];
const render = { width: 1000, height: 1000, image: 'fixture.webp', coordinateSystem: 'WGS84', bbox };
const manifest = { coordinate_system: 'WGS84', bbox_wgs84: bbox, center: { name: '春熙路' } };
const point = { id: 'home', name: '春熙路', coordinateSystem: 'WGS84', pixel: [500, 500], coordinate: [104.075, 30.655] };
const hotspots = { ...render, hotspots: [point, { ...point, id: 'ifs', name: '成都IFS国际金融中心', pixel: [700, 700] }] };

test('scene validation requires matching rendered extent, independent of oversized raw ways', () => {
  assert.equal(validateSceneFiles(render, manifest, hotspots).items.length, 2);
  assert.throws(() => validateSceneFiles(render, { ...manifest, bbox_wgs84: [104.06, 30.64, 104.09, 30.67] }, hotspots), /范围/);
  assert.throws(() => validateSceneFiles(render, manifest, { ...hotspots, width: 900 }), /不匹配/);
  const bad = { ...hotspots, hotspots: [...hotspots.hotspots, { ...point, id: 'outside', coordinate: [105, 31] }, point] };
  assert.equal(validateSceneFiles(render, manifest, bad).items.length, 2);
});

test('pan and zoom stay inside the provided scene and center a smaller image', () => {
  const camera = createMapCamera(1800, 2000);
  camera.resize(1000, 700);
  let s = camera.state(); assert.equal(s.scale, .35); assert.equal(s.x, 185); assert.equal(s.y, 0);
  camera.pan(100000, -100000); assert.deepEqual(camera.state(), s);
  camera.zoomAt(100); s = camera.state(); assert.equal(s.scale, s.maxScale);
  camera.pan(100000, 100000); assert.equal(camera.state().x, 0); assert.equal(camera.state().y, 0);
  camera.pan(-100000, -100000); s = camera.state();
  assert.equal(s.x, 1000 - 1800 * s.scale); assert.equal(s.y, 700 - 2000 * s.scale);
  camera.zoomAt(.00001); assert.equal(camera.state().scale, camera.state().minScale);
});

test('zoom preserves the anchored image point and resize preserves relative zoom', () => {
  const camera = createMapCamera(1000, 1000); camera.resize(800, 600); camera.zoomAt(3);
  const before = camera.state(), anchor = { x: 380, y: 260 };
  const pointAtAnchor = [(anchor.x - before.x) / before.scale, (anchor.y - before.y) / before.scale];
  camera.zoomAt(1.3, anchor);
  assert.ok(camera.toScreen(pointAtAnchor).every((v, i) => Math.abs(v - [anchor.x, anchor.y][i]) < 1e-8));
  const zoom = camera.state().scale / camera.state().minScale;
  camera.resize(600, 800); assert.equal(camera.state().scale / camera.state().minScale, zoom);
});

test('entry buttons, hotspot clicks, simulation, and drag capture work without Baidu SDK', async () => {
  class Element {
    constructor(tag = 'div') {
      Object.assign(this, { tag, hidden: false, disabled: false, value: '', textContent: '', children: [], listeners: new Map(), attributes: new Map(), dataset: {}, clientWidth: 1000, clientHeight: 700, offsetWidth: 125, offsetHeight: 34, captures: 0 });
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(name, handler) { const list = this.listeners.get(name) || []; list.push(handler); this.listeners.set(name, list); }
    trigger(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn({ target: this, button: 0, preventDefault() {}, ...event }); }
    setAttribute(k, v) { this.attributes.set(k, v); }
    removeAttribute(k) { this.attributes.delete(k); }
    toggleAttribute(k, active) { active ? this.setAttribute(k, '') : this.removeAttribute(k); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return this.children.filter(c => c.tag === 'button'); }
    closest(selector) { return selector === 'button' && this.tag === 'button' ? this : null; }
    focus() {} setPointerCapture() { this.captures++; }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    set src(value) { this.source = value; this.naturalWidth = 1000; this.naturalHeight = 1000; queueMicrotask(() => this.onload()); }
  }
  const html = await readFile(new URL('../board-image.html', import.meta.url), 'utf8');
  const elements = new Map();
  for (const match of html.matchAll(/<(\w+)\s+[^>]*id="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]); element.hidden = /\bhidden\b/.test(match[0]);
    if (element.hidden) element.setAttribute('hidden', ''); elements.set(match[2], element);
  }
  for (const category of ['all', 'food', 'shopping', 'landmark', 'metro']) { const button = new Element('button'); button.dataset.category = category; elements.get('filters').append(button); }
  const requests = [], frames = new Map(); let frameId = 0;
  const route = { available: true, coordinateSystem: 'WGS84', name: 'fixture walk', distanceMeters: 100, coordinates: [[104.075, 30.655], [104.077, 30.656]], pixels: [[500, 500], [700, 600]] };
  const files = { './output/game/render.manifest.json': render, './output/scene.manifest.json': manifest, './output/game/chunxi-game.hotspots.json': hotspots, './output/game/route.preview.json': route };
  const replacements = {
    document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag), addEventListener() {} }, window: {},
    localStorage: { getItem: () => null, setItem() {} },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    fetch: async path => { requests.push(path); assert.ok(files[path], `Unexpected request: ${path}`); return { ok: true, json: async () => files[path] }; },
  };
  const originals = new Map(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  try {
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    await import('../local-map.mjs');
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
    const demo = window.localMapDemo; assert.ok(demo, elements.get('loading').textContent);
    assert.ok(requests.every(path => path.startsWith('./output/')));
    assert.equal(elements.get('loading').hidden, true);
    assert.equal(elements.get('route-layer').attributes.has('hidden'), false, 'SVG route must remove the real hidden attribute');
    elements.get('places').trigger('click'); assert.equal(elements.get('place-panel').hidden, false);
    elements.get('place-list').children[1].trigger('click'); assert.equal(demo.state().selected, 'ifs');
    elements.get('visit').trigger('click'); assert.deepEqual(demo.state().visited, ['ifs']);
    elements.get('move-avatar').trigger('click'); assert.deepEqual(demo.state().avatar.pixel, [700, 700]);
    const viewport = elements.get('viewport'), marker = elements.get('markers').children[0];
    viewport.trigger('pointerdown', { target: marker, pointerId: 1, clientX: 300, clientY: 300 });
    assert.equal(viewport.captures, 0, 'hotspot pointer must not be captured by the drag surface');
    marker.trigger('click'); assert.equal(demo.state().selected, 'home');
    viewport.trigger('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 }); assert.equal(viewport.captures, 1);
    viewport.trigger('pointermove', { pointerId: 2, clientX: -99999, clientY: 99999 });
    assert.equal(demo.camera.state().y, 0); viewport.trigger('pointerup', { pointerId: 2 });
    elements.get('route').trigger('click'); assert.equal(elements.get('route-panel').hidden, false);
    elements.get('play-route').trigger('click'); assert.equal(demo.state().walking, true);
    const first = frames.get(frameId); frames.delete(frameId); first(0);
    const second = frames.get(frameId); frames.delete(frameId); second(22500);
    assert.deepEqual(demo.state().avatar.pixel, [600, 550]);
    elements.get('play-route').trigger('click'); assert.equal(demo.state().walking, false);
    elements.get('home').trigger('click'); assert.equal(demo.camera.state().scale, demo.camera.state().minScale);
    const food = elements.get('filters').children[1]; food.trigger('click'); assert.equal(demo.state().category, 'food'); assert.equal(elements.get('place-list').children[0].tag, 'p');
  } finally {
    for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});

