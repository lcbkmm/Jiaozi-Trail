import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../assets/vendor/three.module.js';
import { OrbitControls } from '../assets/vendor/OrbitControls.js';
import { stabilizeCameraView } from '../game-map-navigation.mjs';
import { createDistrictSurroundings } from '../game-map-surroundings.mjs';

test('repeated lateral pans repair the eye and target together, including reversal', () => {
  const buildings = [{ id: 'wall', tags: {}, rings: [[[0, -30], [2, -30], [2, 30], [0, 30]]], displayHeight: 60 }];
  const camera = new T.PerspectiveCamera(); camera.position.set(-8, 10, 0);
  const target = new T.Vector3(-8, 2, -20), direction = target.clone().sub(camera.position);
  let last = camera.position.clone();
  for (let i = 0; i < 30; i++) {
    camera.position.x += 2; target.x += 2;
    last = stabilizeCameraView(camera, target, last, buildings, 1.2);
    assert.ok(camera.position.x < -1.19, 'panning repeatedly must never enter or cross the wall');
    assert.ok(target.clone().sub(camera.position).distanceTo(direction) < 1e-6, 'correction must preserve the viewing vector');
  }
  const blocked = camera.position.x;
  camera.position.x -= 4; target.x -= 4;
  last = stabilizeCameraView(camera, target, last, buildings, 1.2);
  assert.ok(last.x < blocked - 3.99, 'reversing the pan must escape without sticking');
});

test('the ground floor correction cannot push the eye into a suspended building', () => {
  const building = { id: 'bridge', tags: {}, rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], displayBaseHeight: 3, displayHeight: 10 };
  const camera = new T.PerspectiveCamera(); camera.position.set(5, 0, 5);
  const target = new T.Vector3(5, -1, -15), direction = target.clone().sub(camera.position);
  const result = stabilizeCameraView(camera, target, camera.position.clone(), [building], 1.2);
  assert.ok(result.y >= 11.7, 'the 2m eye floor intersects the bridge underside and must be resolved above its roof');
  assert.ok(target.clone().sub(camera.position).distanceTo(direction) < 1e-6);
  assert.deepEqual(stabilizeCameraView(camera, target, result, [building], 1.2), result, 'the repaired view must remain stable');
});

test('real damped OrbitControls pan bursts and reversals keep rendered camera positions outside walls', () => {
  class Element {
    constructor() { this.listeners = new Map(); this.style = {}; this.clientWidth = 1000; this.clientHeight = 700; }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
    trigger(type, event) { for (const fn of [...this.listeners.get(type) || []]) fn({ target: this, preventDefault() {}, button: 0, ...event }); }
    getRootNode() { return this; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture() {} releasePointerCapture() {}
  }
  const element = new Element(), camera = new T.PerspectiveCamera(42, 1000 / 700, .5, 4500);
  camera.position.set(-8, 10, 0);
  const controls = new OrbitControls(camera, element);
  controls.target.set(-8, 2, -20);
  controls.enableDamping = true; controls.dampingFactor = .12; controls.panSpeed = .8;
  controls.screenSpacePanning = false; controls.mouseButtons.LEFT = T.MOUSE.PAN;
  controls.update(); camera.updateMatrixWorld();
  const wall = { id: 'wall', tags: {}, rings: [[[0, -200], [2, -200], [2, 200], [0, 200]]], displayHeight: 60 };
  const direction = controls.target.clone().sub(camera.position);
  let last = camera.position.clone(), x = 800;
  const pointer = () => ({ pointerType: 'mouse', pointerId: 1, clientX: x, clientY: 350, ctrlKey: false, metaKey: false, shiftKey: false });
  const frame = () => {
    controls.update();
    last = stabilizeCameraView(camera, controls.target, last, [wall], 1.2);
    camera.lookAt(controls.target); camera.updateMatrixWorld();
    assert.ok(camera.position.x < -1.19, `pan must stay on the initial side of the wall: ${camera.position.x}`);
    assert.ok(controls.target.clone().sub(camera.position).distanceTo(direction) < 1e-6, 'correction must preserve the actual controls view direction');
  };
  try {
    element.trigger('pointerdown', pointer());
    for (let i = 0; i < 40; i++) {
      // Multiple native pointer events can arrive before the next render frame.
      for (let burst = 0; burst < 3; burst++) { x -= 15; element.trigger('pointermove', pointer()); }
      frame();
    }
    const blocked = camera.position.x;
    for (let i = 0; i < 15; i++) {
      for (let burst = 0; burst < 3; burst++) { x += 15; element.trigger('pointermove', pointer()); }
      frame();
    }
    assert.ok(camera.position.x < blocked - 4, 'reversing real pointer movement must move away from the wall');
    element.trigger('pointerup', pointer());
    for (let i = 0; i < 40; i++) frame();
  } finally { controls.dispose(); }
});

test('chapter surround is below the district and cloud banks remain beyond real bounds', () => {
  const bounds = [-500, -500, 500, 500], surround = createDistrictSurroundings(bounds);
  assert.equal(surround.userData.geography, false);
  surround.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(surround);
  assert.ok(box.max.y < -10, 'surround must never obscure streets or real buildings');
  const clouds = surround.children.find(c => c.isInstancedMesh), matrix = new T.Matrix4();
  for (let i = 0; i < clouds.count; i++) {
    clouds.getMatrixAt(i, matrix);
    const point = new T.Vector3().setFromMatrixPosition(matrix);
    assert.ok(Math.abs(point.x) > 600 || Math.abs(point.z) > 600);
  }
});
