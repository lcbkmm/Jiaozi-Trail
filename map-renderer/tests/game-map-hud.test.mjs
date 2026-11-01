import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMapHud } from '../game-map-hud.mjs';

function fixture({ compact = false, stored = new Map(), omit = [] } = {}) {
  const doc = { activeElement: null }, elements = new Map();
  class Element {
    hidden = false;
    dataset = {};
    attributes = new Map();
    listeners = new Map();
    setAttribute(key, value) { this.attributes.set(key, value); }
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
    removeEventListener(type, listener) { this.listeners.set(type, this.listeners.get(type)?.filter(item => item !== listener)); }
    click() { this.listeners.get('click')?.slice().forEach(listener => listener({ target: this })); }
    contains(element) { return element === this || element?.parentNode === this; }
    focus() { doc.activeElement = this; }
  }
  for (const id of ['map-tool-dock', 'toggle-map-tools', 'map-tool-actions', 'map-category-dock', 'toggle-map-categories', 'filters']) {
    if (!omit.includes(id)) elements.set(id, new Element());
  }
  doc.getElementById = id => elements.get(id);
  const host = { document: doc, matchMedia: () => ({ matches: compact }), localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } };
  return { host, doc, stored, element: id => elements.get(id), child: id => Object.assign(new Element(), { parentNode: elements.get(id) }) };
}

test('each group folds independently, exposes its action and restores the saved choice', () => {
  const view = fixture(), hud = setupMapHud(view.host);
  const tools = view.element('toggle-map-tools'), categories = view.element('toggle-map-categories');
  assert.equal(view.element('map-tool-actions').hidden, false);
  assert.equal(view.element('filters').hidden, false);
  assert.equal(tools.attributes.get('aria-label'), '收起探索工具');
  tools.click();
  assert.equal(view.element('map-tool-actions').hidden, true);
  assert.equal(view.element('map-tool-dock').dataset.collapsed, 'true');
  assert.equal(tools.attributes.get('aria-expanded'), 'false');
  assert.equal(tools.attributes.get('aria-controls'), 'map-tool-actions');
  assert.equal(tools.attributes.get('aria-label'), '展开探索工具');
  assert.equal(view.element('filters').hidden, false, 'folding tools must not hide discovery categories');
  categories.click(); categories.click();
  assert.equal(view.element('map-tool-actions').hidden, true, 'category interaction must preserve the independent tools choice');
  hud.destroy();
  const next = fixture({ compact: true, stored: view.stored });
  setupMapHud(next.host);
  assert.equal(next.element('map-tool-actions').hidden, true);
  assert.equal(next.element('filters').hidden, false, 'an explicit saved choice wins over the compact default');
});

test('compact screens start folded and expanded controls remain fully usable', () => {
  const view = fixture({ compact: true });
  setupMapHud(view.host);
  assert.equal(view.element('map-tool-actions').hidden, true);
  assert.equal(view.element('filters').hidden, true);
  view.element('toggle-map-categories').click();
  assert.equal(view.element('filters').hidden, false);
  assert.equal(view.element('toggle-map-categories').attributes.get('title'), '收起地点分类');
  assert.equal(view.element('toggle-map-categories').attributes.get('aria-expanded'), 'true');
});

test('folding moves focus out of hidden controls without stealing unrelated focus', () => {
  const view = fixture();
  setupMapHud(view.host);
  view.child('map-tool-actions').focus();
  view.element('toggle-map-tools').click();
  assert.equal(view.doc.activeElement, view.element('toggle-map-tools'));
  const unrelated = {};
  view.doc.activeElement = unrelated;
  view.element('toggle-map-categories').click();
  assert.equal(view.doc.activeElement, unrelated);
});

test('corrupt preferences, denied storage and absent media queries do not block folding', () => {
  for (const storedValue of ['not-json', 'null', '[]', '{"tools":"false","categories":null}']) {
    const view = fixture({ stored: new Map([['jiaozi-map-hud-v1', storedValue]]) });
    delete view.host.matchMedia;
    view.host.localStorage.setItem = () => { throw new Error('quota exceeded'); };
    setupMapHud(view.host);
    assert.equal(view.element('filters').hidden, false);
    view.element('toggle-map-tools').click();
    assert.equal(view.element('map-tool-actions').hidden, true);
    view.element('toggle-map-tools').click();
    assert.equal(view.element('map-tool-actions').hidden, false);
  }
  const view = fixture({ compact: true });
  Object.defineProperty(view.host, 'localStorage', { get() { throw new Error('storage denied'); } });
  setupMapHud(view.host);
  view.element('toggle-map-tools').click();
  assert.equal(view.element('map-tool-actions').hidden, false);
});

test('optional groups can be absent and teardown removes only HUD listeners', () => {
  assert.doesNotThrow(() => setupMapHud({}).destroy());
  const view = fixture({ omit: ['map-tool-dock'] });
  let businessClicks = 0;
  view.element('toggle-map-categories').addEventListener('click', () => businessClicks++);
  const hud = setupMapHud(view.host);
  view.element('toggle-map-categories').click();
  assert.equal(view.element('filters').hidden, true);
  hud.destroy(); hud.destroy();
  view.element('toggle-map-categories').click();
  assert.equal(view.element('filters').hidden, true);
  assert.equal(businessClicks, 2, 'teardown must preserve unrelated handlers');
});
