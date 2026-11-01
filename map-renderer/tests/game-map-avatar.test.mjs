import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../assets/vendor/three.module.js';
import { DEFAULT_AVATAR_PROFILE, normalizeAvatarProfile, createMapAvatar, applyAvatarProfile, whenAvatarPhotoReady, animateMapAvatar, disposeMapAvatar } from '../game-map-avatar.mjs';

const photoA = 'data:image/png;base64,YQ==', photoB = 'data:image/webp;base64,Yg==';

test('profiles are deterministic, local-only and safe to import without a DOM', () => {
  assert.equal(typeof document, 'undefined');
  const input = { name: '  小旅人  ', skinColor: '#AAbbCC', hairColor: 'url(secret)', outfitColor: '#123456', hairStyle: 'bob', photoDataUrl: 'https://example.com/face.png' };
  const before = JSON.stringify(input), profile = normalizeAvatarProfile(input);
  assert.equal(profile.name, '小旅人'); assert.equal(profile.skinColor, '#aabbcc'); assert.equal(profile.hairColor, DEFAULT_AVATAR_PROFILE.hairColor);
  assert.equal(profile.hairStyle, 'bob'); assert.equal(profile.photoDataUrl, null);
  assert.equal(JSON.stringify(input), before, 'normalization cannot change the editor input');
  for (const invalid of [null, 'invalid', { hairStyle: 'other' }, { photoDataUrl: 'data:image/svg+xml;base64,YQ==' }]) assert.deepEqual(normalizeAvatarProfile(invalid), DEFAULT_AVATAR_PROFILE);
  assert.equal(normalizeAvatarProfile({ photoDataUrl: photoA }).photoDataUrl, photoA);
  assert.equal(normalizeAvatarProfile({ photoDataUrl: 'data:image/png;base64,' + 'Y'.repeat(4_000_000) }).photoDataUrl, null);
});

test('smooth articulated character has a complete finite silhouette at the map avatar scale', () => {
  const avatar = createMapAvatar(); avatar.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(avatar);
  assert.ok(box.min.y >= 0, 'feet and navigation indicator cannot extend below the street');
  assert.ok(box.max.y > 3.4 && box.max.y < 3.8, 'the old avatar can be replaced without changing map scale');
  for (const name of ['head', 'hair-cap', 'jacket', 'inner-shirt', 'backpack', 'left-arm', 'right-arm', 'left-leg', 'right-leg', 'eye', 'smile', 'sneaker-upper']) assert.ok(avatar.getObjectByName(name), `missing character feature: ${name}`);
  const head = avatar.getObjectByName('head');
  assert.ok(head.geometry.parameters.widthSegments >= 32);
  const eye = avatar.getObjectByName('eye'); assert.ok(eye.position.z > 0, 'the face must look along +Z, matching route heading');
  avatar.traverse(object => {
    if (!object.isMesh) return;
    assert.ok(object.geometry.getAttribute('normal'), `${object.name} needs smooth surface normals`);
    for (const key of ['position', 'normal']) assert.ok(object.geometry.getAttribute(key).array.every(Number.isFinite), `${object.name} has invalid ${key}`);
  });
  disposeMapAvatar(avatar);
});

test('profile changes preserve map position and heading and do not recolor other avatars', () => {
  const first = createMapAvatar(), second = createMapAvatar();
  first.position.set(20, .25, -50); first.rotation.y = 1.3;
  const result = applyAvatarProfile(first, { outfitColor: '#123456', hairStyle: 'bob' });
  assert.equal(result, first); assert.deepEqual(first.position.toArray(), [20, .25, -50]); assert.equal(first.rotation.y, 1.3);
  assert.equal(first.getObjectByName('jacket').material.color.getHexString(), '123456');
  assert.equal(second.getObjectByName('jacket').material.color.getHexString(), DEFAULT_AVATAR_PROFILE.outfitColor.slice(1));
  assert.equal(first.getObjectByName('bob-hair').visible, true); assert.equal(first.getObjectByName('short-hair').visible, false);
  applyAvatarProfile(first, { accentColor: '#abcdef' });
  assert.equal(first.userData.avatarProfile.outfitColor, '#123456', 'partial edits retain the current outfit');
  assert.equal(first.userData.avatarProfile.hairStyle, 'bob');
  disposeMapAvatar(first); disposeMapAvatar(second);
});

test('the curved portrait retains the editor aspect and does not mirror or invert the image', () => {
  const avatar = createMapAvatar(), patch = avatar.getObjectByName('local-photo-face');
  patch.updateMatrixWorld(true);
  const extent = new T.Box3().setFromObject(patch).getSize(new T.Vector3());
  assert.ok(Math.abs(extent.x / extent.y - 156 / 162) < .02, 'a portrait must not become a wide face when applied');
  const positions = patch.geometry.getAttribute('position'), uv = patch.geometry.getAttribute('uv');
  let left, right, top, bottom;
  for (let i = 0; i < positions.count; i++) {
    const point = { x: positions.getX(i), y: positions.getY(i), u: uv.getX(i), v: uv.getY(i) };
    if (!left || point.x < left.x) left = point;
    if (!right || point.x > right.x) right = point;
    if (!top || point.y > top.y) top = point;
    if (!bottom || point.y < bottom.y) bottom = point;
  }
  assert.ok(left.u < right.u, 'left and right in the photo stay left and right on the face');
  assert.ok(top.v > bottom.v, 'the top of the portrait stays at the forehead with the default texture flipY');
  disposeMapAvatar(avatar);
});

function fakeImages(run) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), images = [];
  class Image {
    constructor() { this.listeners = new Map(); this.width = this.height = 256; images.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
    emit(type) { this.listeners.get(type)?.call(this, { type }); }
  }
  Object.defineProperty(globalThis, 'document', { value: { createElementNS: () => new Image() }, configurable: true });
  return Promise.resolve().then(() => run(images)).finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
  });
}

test('local photo loading follows the curved head and old async requests cannot overwrite a new profile', () => fakeImages(async images => {
  const originalDispose = T.Texture.prototype.dispose, disposed = new Set();
  T.Texture.prototype.dispose = function () { disposed.add(this); originalDispose.call(this); };
  let avatar;
  try {
    avatar = createMapAvatar({ photoDataUrl: photoA });
    const oldReady = whenAvatarPhotoReady(avatar), patch = avatar.getObjectByName('local-photo-face'), fallback = avatar.getObjectByName('drawn-face');
    assert.equal(images.length, 1); assert.equal(patch.visible, false); assert.equal(fallback.visible, true);
    applyAvatarProfile(avatar, { photoDataUrl: photoB });
    const newReady = whenAvatarPhotoReady(avatar);
    assert.equal(disposed.size, 1, 'changing photos immediately releases the abandoned GPU texture');
    images[0].emit('load'); assert.equal(await oldReady, false);
    assert.equal(avatar.userData.avatarPhotoState, 'loading'); assert.equal(patch.visible, false);
    images[1].emit('load'); assert.equal(await newReady, true);
    assert.equal(avatar.userData.avatarPhotoState, 'ready'); assert.equal(patch.material.map.image, images[1]);
    assert.equal(patch.material.map.colorSpace, T.SRGBColorSpace); assert.equal(patch.visible, true); assert.equal(fallback.visible, false);
    assert.equal(patch.geometry.type, 'SphereGeometry', 'the head photo cannot be a flat rectangular billboard');
    const activeTexture = patch.material.map;
    applyAvatarProfile(avatar, { photoDataUrl: null });
    assert.ok(disposed.has(activeTexture)); assert.equal(patch.material.map, null);
    assert.equal(patch.visible, false); assert.equal(fallback.visible, true); assert.equal(avatar.userData.avatarPhotoState, 'none');
  } finally { if (avatar) disposeMapAvatar(avatar); T.Texture.prototype.dispose = originalDispose; }
}));

test('a failed decode retains the modeled face and a disposed avatar ignores late image completion', () => fakeImages(async images => {
  const failed = createMapAvatar({ photoDataUrl: photoA });
  const failedReady = whenAvatarPhotoReady(failed);
  images[0].emit('error'); assert.equal(await failedReady, false);
  assert.equal(failed.userData.avatarPhotoState, 'error'); assert.equal(failed.getObjectByName('drawn-face').visible, true);
  const disposed = createMapAvatar({ photoDataUrl: photoB });
  const disposedReady = whenAvatarPhotoReady(disposed); disposeMapAvatar(disposed);
  images[1].emit('load'); assert.equal(await disposedReady, false);
  assert.equal(disposed.getObjectByName('local-photo-face').material.map, null);
  assert.throws(() => applyAvatarProfile(disposed, {}), /living character/);
  disposeMapAvatar(failed);
}));

test('walking animates limbs without changing geographic position, yaw or profile', () => {
  const avatar = createMapAvatar(); avatar.position.set(50, .25, 12); avatar.rotation.y = .8;
  const profile = JSON.stringify(avatar.userData.avatarProfile);
  animateMapAvatar(avatar, .2, true);
  assert.notEqual(avatar.getObjectByName('left-leg').rotation.x, 0);
  assert.equal(avatar.getObjectByName('left-leg').rotation.x, -avatar.getObjectByName('left-arm').rotation.x * .29 / .32);
  animateMapAvatar(avatar, .5, false);
  assert.equal(avatar.getObjectByName('left-leg').rotation.x, 0); assert.equal(avatar.getObjectByName('right-arm').rotation.x, 0);
  assert.deepEqual(avatar.position.toArray(), [50, .25, 12]); assert.equal(avatar.rotation.y, .8);
  assert.equal(JSON.stringify(avatar.userData.avatarProfile), profile);
  animateMapAvatar(avatar, NaN, true); assert.ok(Number.isFinite(avatar.getObjectByName('avatar-body').position.y));
  disposeMapAvatar(avatar);
});

test('shared mesh resources are each released once when a character is disposed', () => {
  const avatar = createMapAvatar(), geometries = new Map(), materials = new Map();
  avatar.traverse(object => {
    if (!object.isMesh) return;
    geometries.set(object.geometry, 0); materials.set(object.material, 0);
  });
  for (const resource of [...geometries.keys(), ...materials.keys()]) resource.addEventListener('dispose', () => {
    const table = geometries.has(resource) ? geometries : materials; table.set(resource, table.get(resource) + 1);
  });
  disposeMapAvatar(avatar); disposeMapAvatar(avatar);
  assert.ok([...geometries.values(), ...materials.values()].every(count => count === 1));
});
