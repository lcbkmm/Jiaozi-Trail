import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { spriteLayout, createSpriteLayer } from '../landmark-sprites.mjs';

const manifest = JSON.parse(await readFile(new URL('../landmarks.json', import.meta.url), 'utf8'));
const fixture = manifest.landmarks[0];

function harness(zoom = fixture.baseZoom) {
  const icons = [];
  class Point { constructor(lng, lat) { Object.assign(this, {lng, lat}); } }
  class Size { constructor(width, height) { Object.assign(this, {width, height}); } }
  class Icon {
    constructor(asset, size, options) {
      Object.assign(this, {asset, size, options});
      icons.push(this);
    }
  }
  class Marker {
    constructor(position) { this.position=position; this.visible=true; }
    setIcon(icon) { this.icon=icon; }
    hide() { this.visible=false; }
    show() { this.visible=true; }
  }
  const overlays = [];
  const listeners = new Map();
  const map = {
    zoom,
    getZoom() { return this.zoom; },
    addOverlay(marker) { overlays.push(marker); },
    removeOverlay(marker) { overlays.splice(overlays.indexOf(marker), 1); },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name) { for (const callback of listeners.get(name) || []) callback(); },
  };
  return {map, sdk:{Point, Size, Icon, Marker}, overlays, listeners, icons};
}

test('manifest retains a real geographic anchor and available replaceable artwork', async () => {
  assert.equal(manifest.coordinateSystem, 'BD09LL');
  assert.ok(manifest.landmarks.length > 0);
  for (const sprite of manifest.landmarks) {
    assert.equal(sprite.illustrative, true);
    const asset = new URL(sprite.asset, new URL('../landmarks.json', import.meta.url));
    await access(asset);
    assert.equal(spriteLayout(sprite, sprite.baseZoom).visible, true);
  }
});

test('one zoom level scales artwork and its contact anchor by the same factor', () => {
  const base = spriteLayout(fixture, fixture.baseZoom);
  const enlarged = spriteLayout(fixture, fixture.baseZoom+1);
  const reduced = spriteLayout(fixture, fixture.baseZoom-1);
  assert.deepEqual(enlarged.size, base.size.map(n=>n*2));
  assert.deepEqual(enlarged.anchor, base.anchor.map(n=>n*2));
  assert.deepEqual(reduced.size, base.size.map(n=>n/2));
  assert.deepEqual(reduced.anchor, base.anchor.map(n=>n/2));
  for (const layout of [base, enlarged, reduced]) {
    // Pixel offset below the contact point scales with the image as well.
    assert.equal(layout.anchor[0]/layout.size[0], base.anchor[0]/base.size[0]);
    assert.equal(layout.anchor[1]/layout.size[1], base.anchor[1]/base.size[1]);
  }
});

test('hidden artwork never creates unbounded icon dimensions at distant zoom levels', () => {
  for (const zoom of [-1000, fixture.minZoom-0.01, fixture.maxZoom+0.01, 1000]) {
    const layout = spriteLayout(fixture, zoom);
    assert.equal(layout.visible, false);
    assert.deepEqual(layout.size, fixture.size);
    assert.ok(layout.anchor.every(Number.isFinite));
  }
  assert.equal(spriteLayout(fixture, fixture.minZoom).visible, true);
  assert.equal(spriteLayout(fixture, fixture.maxZoom).visible, true);
});

test('reject malformed geographic coordinates before creating overlays', () => {
  for (const coordinate of [null, [], [104], [104,30,1], [NaN,30], [104,Infinity], [181,30], [104,-91], ['104',30]]) {
    assert.throws(()=>spriteLayout({...fixture, coordinate}, 18), /coordinate/);
  }
  const h=harness();
  assert.throws(()=>createSpriteLayer({...h,sprites:[fixture,{...fixture,coordinate:[181,30]}]}));
  assert.equal(h.overlays.length, 0);
});

test('reject invalid artwork dimensions, contact anchors, and zoom metadata', () => {
  const invalid = [
    {size:[0,190]}, {size:[160,-1]}, {size:[NaN,190]}, {size:[160]},
    {anchor:[161,174]}, {anchor:[80,-1]}, {anchor:[80,Infinity]},
    {baseZoom:NaN}, {minZoom:Infinity}, {minZoom:20,maxZoom:16},
  ];
  for (const properties of invalid) {
    assert.throws(()=>spriteLayout({...fixture,...properties},18), /dimensions|range/);
  }
  assert.throws(()=>spriteLayout(fixture,Infinity), /dimensions|range/);
});

test('zooming resizes the SDK image and anchor while retaining its geographic point', () => {
  const h=harness();
  const layer=createSpriteLayer({...h,sprites:[fixture]});
  const marker=h.overlays[0];
  const position=marker.position;
  assert.deepEqual([position.lng,position.lat],fixture.coordinate);
  assert.deepEqual([marker.icon.size.width,marker.icon.size.height],fixture.size);
  h.map.zoom=fixture.baseZoom+1;
  h.map.emit('zooming');
  assert.equal(marker.position,position);
  assert.deepEqual([marker.icon.size.width,marker.icon.size.height],fixture.size.map(n=>n*2));
  assert.deepEqual(marker.icon.options.imageSize,marker.icon.size);
  assert.deepEqual([marker.icon.options.anchor.width,marker.icon.options.anchor.height],fixture.anchor.map(n=>n*2));
  h.map.emit('zoomend');
  assert.equal(marker.position,position);
  assert.equal(layer.diagnostics().visible,1);
});

test('visibility toggle persists through zoom changes and hidden icons are not allocated', () => {
  const h=harness();
  const layer=createSpriteLayer({...h,sprites:[fixture]});
  const marker=h.overlays[0];
  layer.setVisible(false);
  const iconCount=h.icons.length;
  h.map.zoom=fixture.baseZoom+1;
  h.map.emit('zoomend');
  assert.equal(marker.visible,false);
  assert.equal(h.icons.length,iconCount);
  assert.deepEqual(layer.diagnostics(),{enabled:false,count:1,visible:0});
  layer.setVisible(true);
  assert.equal(marker.visible,true);
  h.map.zoom=fixture.maxZoom+1;
  h.map.emit('zoomend');
  assert.equal(marker.visible,false);
  assert.equal(layer.diagnostics().visible,0);
  h.map.zoom=fixture.baseZoom;
  h.map.emit('zoomend');
  assert.equal(marker.visible,true);
});

test('destroy removes overlays and all zoom listeners', () => {
  const h=harness();
  const layer=createSpriteLayer({...h,sprites:[fixture]});
  layer.destroy();
  assert.equal(h.overlays.length,0);
  assert.equal([...h.listeners.values()].reduce((n,listeners)=>n+listeners.size,0),0);
  const iconCount=h.icons.length;
  h.map.emit('zooming');
  h.map.emit('zoomend');
  assert.equal(h.icons.length,iconCount);
});

test('reject remote artwork before adding any overlay', () => {
  const h=harness();
  assert.throws(()=>createSpriteLayer({...h,sprites:[fixture,{...fixture,asset:'https://example.com/assets/landmarks/test.png'}]}), /local asset/);
  assert.equal(h.overlays.length,0);
});
