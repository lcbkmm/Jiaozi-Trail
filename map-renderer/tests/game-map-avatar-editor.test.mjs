import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_STORAGE_KEY, validateAvatarPhoto, avatarCropRect, cartoonizeAvatarPixels, readAvatarProfile, saveAvatarProfile, createAvatarCameraSession, createAvatarEditor } from '../game-map-avatar-editor.mjs';
import { AvatarEditorTestElement as Element } from './helpers/avatar-editor-dom.mjs';

test('photo input rejects unsupported and oversized images before decoding', () => {
  assert.throws(() => validateAvatarPhoto({ size: 1, type: 'image/svg+xml' }), /支持 JPG/);
  assert.throws(() => validateAvatarPhoto({ size: 20 * 1024 * 1024, type: 'image/jpeg' }), /12 MB/);
  assert.throws(() => validateAvatarPhoto({ size: 0, type: 'image/png' }), /有效照片/);
  assert.doesNotThrow(() => validateAvatarPhoto({ size: 100, type: '', name: 'Camera.JPG' }));
  assert.doesNotThrow(() => validateAvatarPhoto({ size: 100, type: 'image/webp' }));
});

test('square crop remains within real image bounds at all adjustments and aspect ratios', () => {
  for (const [w, h] of [[4096, 1000], [900, 4000], [1000, 1000]]) for (const zoom of [0, 1, 2, 3, 99]) for (const x of [-4, -1, 0, 1, 4]) for (const y of [-1, 0, 1]) {
    const crop = avatarCropRect(w, h, { zoom, x, y });
    assert.equal(crop.width, crop.height); assert.ok(crop.width > 0);
    assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= w + 1e-8 && crop.y + crop.height <= h + 1e-8);
  }
  assert.throws(() => avatarCropRect(0, 100), /尺寸无效/);
});

test('local cartoon processing preserves alpha, sharp silhouettes and non-blocky facial detail', () => {
  const w = 20, h = 12, source = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, value = x < 10 ? 25 + x * 2 : 205 + x;
    source.set([value, value - 5, value - 10, x === 0 ? 80 : 255], i);
  }
  const original = source.slice(), result = cartoonizeAvatarPixels(source, w, h);
  assert.deepEqual(source, original, 'must not mutate the original photo');
  for (let i = 3; i < result.length; i += 4) assert.equal(result[i], source[i]);
  const at = (x, y) => result[(y * w + x) * 4];
  assert.ok(at(10, 5) - at(9, 5) > 140, 'silhouette edges should stay crisp');
  assert.ok(new Set(Array.from({ length: 8 }, (_, x) => at(x + 1, 5))).size >= 5, 'smooth detail must not become large uniform blocks');
  assert.throws(() => cartoonizeAvatarPixels(new Uint8Array(3), 2, 2), /数据无效/);
});

test('local profile sanitizes corrupt/external photo data and tolerates denied storage', () => {
  assert.equal(readAvatarProfile({ getItem: () => '{broken' }).photoDataUrl, null);
  const storage = { value: null, getItem() { return this.value; }, setItem(key, value) { assert.equal(key, AVATAR_STORAGE_KEY); this.value = value; } };
  assert.equal(saveAvatarProfile(storage, { name: '我', photoDataUrl: 'https://tracker.example/portrait.png', skinColor: '#ffeecc' }), true);
  assert.equal(readAvatarProfile(storage).name, '我'); assert.equal(readAvatarProfile(storage).photoDataUrl, null);
  assert.equal(saveAvatarProfile({ setItem() { throw Error('quota'); } }, {}), false);
  assert.equal(saveAvatarProfile(undefined, {}), false);
});

test('camera stops permission requests resolving after close and replacement streams', async () => {
  const requests = [], stopped = [];
  const session = createAvatarCameraSession({ getUserMedia: options => { assert.equal(options.audio, false); return new Promise(resolve => requests.push(resolve)); } });
  const stream = id => ({ getTracks: () => [{ stop: () => stopped.push(id) }] });
  const first = session.start(); session.stop(); requests.shift()(stream('late'));
  assert.equal(await first, null); assert.deepEqual(stopped, ['late']);
  const second = session.start(); requests.shift()(stream('active')); assert.ok(await second);
  const third = session.start(); assert.deepEqual(stopped, ['late', 'active']);
  requests.shift()(stream('replacement')); await third; session.stop(); session.stop();
  assert.deepEqual(stopped, ['late', 'active', 'replacement']);
});

function harness({ storageDenied = false, mediaDevices, failApply = false } = {}) {
  const doc = { createElement: type => new Element(doc, type) }; doc.body = new Element(doc); doc.activeElement = new Element(doc, 'entry');
  const values = new Map(), changes = [], applies = [], pendingImages = [], revoked = [];
  const host = { document: doc, navigator: { mediaDevices }, localStorage: { getItem: key => values.get(key), removeItem: key => values.delete(key), setItem(key, value) { if (storageDenied) throw Error('quota'); values.set(key, value); } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: value => revoked.push(value) }, Image: class { set src(value) { this.source = value; pendingImages.push(this); } } };
  const editor = createAvatarEditor({ host, onOpenChange: v => changes.push(v), onApply: (profile, meta) => { if (failApply) throw Error('角色渲染失败'); applies.push({ profile, meta }); } });
  const dialog = doc.body.children[0], node = key => dialog.nodes.get(key), submit = () => dialog.nodes.get('form').dispatchEvent(new Event('submit', { cancelable: true }));
  return { editor, doc, changes, applies, node, submit, values, pendingImages, revoked, host };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('editor applies only on confirmation, preserves focus and reports storage failure', () => {
  const h = harness({ storageDenied: true }), focus = h.doc.activeElement;
  h.editor.open(); h.node('name').value = '临时名字'; h.node('name').dispatchEvent(new Event('input')); h.editor.close();
  assert.equal(h.applies.length, 0); assert.equal(h.doc.activeElement, focus);
  h.editor.open(); assert.notEqual(h.node('name').value, '临时名字');
  h.node('name').value = '卡通旅人'; h.node('name').dispatchEvent(new Event('input')); h.submit();
  assert.equal(h.applies.length, 1); assert.equal(h.applies[0].profile.name, '卡通旅人'); assert.equal(h.applies[0].meta.persisted, false);
  assert.equal(h.editor.currentProfile().name, '卡通旅人'); assert.equal(h.editor.isOpen(), false);
  assert.deepEqual(h.changes, [true, false, true, false]); h.editor.destroy(); h.editor.open(); assert.equal(h.editor.isOpen(), false);
});

test('confirmed outfit is persisted and reopening uses the applied profile', () => {
  const h = harness(); h.editor.open(); h.node('outfitColor').value = '#2877ad'; h.node('outfitColor').dispatchEvent(new Event('input')); h.node('hairStyle').value = 'bob'; h.node('hairStyle').dispatchEvent(new Event('input')); h.submit();
  assert.equal(h.applies[0].meta.persisted, true); assert.equal(readAvatarProfile(h.host.localStorage).outfitColor, '#2877ad'); assert.equal(readAvatarProfile(h.host.localStorage).hairStyle, 'bob');
  h.editor.open(); assert.equal(h.node('outfitColor').value, '#2877ad'); h.node('reset').click(); h.editor.close();
  assert.equal(readAvatarProfile(h.host.localStorage).outfitColor, '#2877ad', 'cancelling reset must preserve confirmed outfit'); h.editor.destroy();
});

test('renderer rejection leaves saved and current profile intact for retry', () => {
  const h = harness({ failApply: true }), before = h.editor.currentProfile();
  h.editor.open(); h.node('outfitColor').value = '#2877ad'; h.node('outfitColor').dispatchEvent(new Event('input')); h.submit();
  assert.equal(h.editor.isOpen(), true); assert.match(h.node('status').textContent, /渲染失败/);
  assert.deepEqual(h.editor.currentProfile(), before); assert.equal(h.values.has(AVATAR_STORAGE_KEY), false); h.editor.destroy();
});

test('pending camera can be cancelled and old rejection cannot stop a new camera', async () => {
  const requests = [], stopped = [];
  const h = harness({ mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) } });
  h.editor.open(); h.node('camera').click();
  assert.equal(h.node('camera-panel').hidden, false); assert.equal(h.node('shutter').disabled, true);
  h.node('cancel-camera').click(); assert.equal(h.node('camera-panel').hidden, true);
  h.node('camera').click(); const next = { getTracks: () => [{ stop: () => stopped.push('next') }] };
  requests[1].resolve(next); await tick(); assert.equal(h.node('video').srcObject, next); assert.equal(h.node('shutter').disabled, false);
  requests[0].reject(Object.assign(Error('denied'), { name: 'NotAllowedError' })); await tick();
  assert.equal(h.node('video').srcObject, next); assert.deepEqual(stopped, []);
  h.editor.close(); assert.deepEqual(stopped, ['next']); assert.equal(h.node('video').srcObject, null); h.editor.destroy();
});

test('closing while a photo decodes discards late image and revokes its local URL', async () => {
  const h = harness(); h.editor.open(); h.node('file').files = [{ size: 200, type: 'image/jpeg' }]; h.node('file').dispatchEvent(new Event('change'));
  assert.equal(h.pendingImages.length, 1); h.editor.close();
  const image = h.pendingImages.shift(); image.naturalWidth = image.naturalHeight = 1000; image.onload(); await tick();
  assert.deepEqual(h.revoked, ['blob:test']); assert.equal(h.editor.currentProfile().photoDataUrl, null);
  h.editor.open(); assert.equal(h.node('apply').disabled, false); h.editor.destroy();
});

test('photo decode errors remain editable and never store broken image data', async () => {
  const h = harness(); h.editor.open(); h.node('file').files = [{ size: 200, type: 'image/jpeg' }]; h.node('file').dispatchEvent(new Event('change'));
  h.pendingImages.shift().onerror(); await tick();
  assert.match(h.node('status').textContent, /解码失败/); assert.equal(h.node('apply').disabled, false); assert.deepEqual(h.revoked, ['blob:test']);
  h.submit(); assert.equal(h.applies[0].profile.photoDataUrl, null); h.editor.destroy();
});

test('successful local photo crop produces a small raster profile without original image URL', async () => {
  const h = harness(); h.editor.open(); h.node('file').files = [{ size: 200, type: 'image/jpeg' }]; h.node('file').dispatchEvent(new Event('change'));
  const image = h.pendingImages.shift(); image.naturalWidth = 1600; image.naturalHeight = 900; image.onload(); await tick();
  assert.equal(h.node('crop-panel').hidden, false); h.submit();
  assert.equal(h.applies[0].profile.photoDataUrl, 'data:image/webp;base64,AAAA');
  assert.ok(!h.values.get(AVATAR_STORAGE_KEY).includes('blob:test')); assert.deepEqual(h.revoked, ['blob:test']); h.editor.destroy();
});
