import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as T from '../assets/vendor/three.module.js';
import { prepareScene } from '../game-map-model.mjs';
import { createAdaptiveDepth, MINIMUM_CAMERA_NEAR } from '../game-map-depth.mjs';

const geo = JSON.parse(await readFile(new URL('../output/scene.geojson', import.meta.url), 'utf8'));
const model = prepareScene(geo);
const depthBin = (distance, near, far) => Math.round((far / (far - near) - far * near / ((far - near) * distance)) * (2 ** 24 - 1));
const projectedBin = (point, camera) => Math.round((point.clone().project(camera).z * .5 + .5) * (2 ** 24 - 1));
const depth = createAdaptiveDepth(model);

test('24-bit regression reproduces far road/marking flicker with the former fixed near plane', () => {
  const angle = 58 * Math.PI / 180, rayDifference = .02 / Math.sin(angle);
  let unresolved = 0;
  for (let i = 0; i <= 1000; i++) {
    const z = 1000 + i * .01;
    if (depthBin(z, .5, 4500) === depthBin(z + rayDifference, .5, 4500)) unresolved++;
  }
  assert.ok(unresolved > 750, 'far 2cm layers must reproduce an actual integer-depth collision before the repair');
});

test('real district pans and zoomed-out views keep 2cm ground layers in distinct depth bins', () => {
  assert.equal(depth.volumes.length, model.buildings.length);
  const camera = new T.PerspectiveCamera(42, 16 / 9, .5, 4500);
  let frames = 0;
  for (const angle of [7, 18, 32, 51, 58, 80]) for (const distance of [900, 1500, 2100]) {
    const radians = angle * Math.PI / 180;
    const offset = new T.Vector3(.35, 0, .94).normalize().multiplyScalar(distance * Math.cos(radians));
    offset.y = distance * Math.sin(radians);
    for (let pan = -400; pan <= 400; pan += 8) {
      const target = new T.Vector3(pan, .14, 0);
      camera.position.copy(target).add(offset); camera.lookAt(target); camera.updateMatrixWorld(true);
      const near = depth.update(camera);
      assert.ok(near > MINIMUM_CAMERA_NEAR, `overview must improve depth precision, angle=${angle}, range=${distance}, x=${pan}`);
      // At one screen pixel, two horizontal planes are separated along the ray
      // by deltaY/sin(elevation), rather than by deltaY*sin(elevation).
      const rayDifference = .02 / Math.sin(radians);
      for (const z of [distance * .8, distance, Math.min(4200, distance * 1.6)]) {
        assert.notEqual(depthBin(z, near, camera.far), depthBin(z + rayDifference, near, camera.far),
          `markings must not share road depth, angle=${angle}, range=${distance}, pan=${pan}, z=${z}, near=${near}`);
      }
      // Check the actual Three.js projection as well as the analytic stress
      // samples: intersections of this exact screen ray with road and paint.
      const direction = target.clone().sub(camera.position).normalize();
      const road = camera.position.clone().addScaledVector(direction, (.14 - camera.position.y) / direction.y);
      const marking = camera.position.clone().addScaledVector(direction, (.16 - camera.position.y) / direction.y);
      assert.notEqual(projectedBin(road, camera), projectedBin(marking, camera));
      frames++;
    }
  }
  assert.equal(frames, 1818);
});

test('near-plane corners stay in empty space across bearings, tall roofs and ultrawide screens', () => {
  const building = { id: 'tower', rings: [[[0, 0], [20, 0], [20, 20], [0, 20]]], displayHeight: 160 };
  const precision = createAdaptiveDepth({ buildings: [building] });
  for (const aspect of [.42, 1, 16 / 9, 5]) for (const eye of [[10, 320, 10], [-100, 20, 10], [10, 300, 150]]) {
    const camera = new T.PerspectiveCamera(42, aspect, .5, 4500); camera.position.set(...eye);
    for (const target of [[10, 20, 10], [200, 0, 10], [10, 50, -200]]) {
      camera.lookAt(new T.Vector3(...target)); camera.updateMatrixWorld(true);
      const near = precision.update(camera), nearest = precision.nearestDistance(camera.position);
      const halfHeight = near * Math.tan(camera.fov * Math.PI / 360), halfWidth = halfHeight * aspect;
      assert.ok(near > MINIMUM_CAMERA_NEAR);
      for (const x of [-halfWidth, halfWidth]) for (const y of [-halfHeight, halfHeight]) {
        const corner = camera.localToWorld(new T.Vector3(x, y, -near));
        assert.ok(corner.distanceTo(camera.position) < nearest * .721, 'whole rectangle must be inside conservative empty sphere');
        assert.ok(corner.y > 18, 'near plane cannot intersect ground markers');
        for (const volume of precision.volumes) {
          assert.ok(corner.x < volume.min[0] || corner.x > volume.max[0] || corner.y < volume.min[1] || corner.y > volume.max[1] || corner.z < volume.min[2] || corner.z > volume.max[2]);
        }
      }
    }
  }
});

test('approaching a building or ground resets near immediately; orthographic views retain linear precision', () => {
  const camera = new T.PerspectiveCamera(42, 1.6, .5, 4500);
  camera.position.set(0, 1200, 900); assert.ok(depth.update(camera) > 100);
  const roof = depth.volumes[0];
  camera.position.set((roof.min[0] + roof.max[0]) / 2, roof.max[1] + .1, (roof.min[2] + roof.max[2]) / 2);
  assert.equal(depth.update(camera), MINIMUM_CAMERA_NEAR, 'a zoom-in must recover close clipping in the very same frame');
  camera.position.set(0, 2, 0); assert.equal(depth.update(camera), MINIMUM_CAMERA_NEAR);
  camera.position.set(0, 1500, 0); camera.zoom = 2; assert.ok(depth.update(camera) > 100);
  const plan = new T.OrthographicCamera(-600, 600, 600, -600, 100, 4500);
  plan.position.copy(camera.position); assert.equal(depth.update(plan), MINIMUM_CAMERA_NEAR);
  const invalid = new T.PerspectiveCamera(42, NaN, 128, 4500);
  invalid.position.set(0, 1000, 0); assert.equal(depth.update(invalid), MINIMUM_CAMERA_NEAR);
});

test('only projection changes when needed; physical eye clearance remains separate', () => {
  const camera = new T.PerspectiveCamera(42, 1.6, .5, 4500);
  camera.position.set(0, 1500, 900); camera.lookAt(new T.Vector3()); camera.updateMatrixWorld(true);
  const eye = camera.position.clone(), rotation = camera.quaternion.clone(), far = camera.far;
  let updates = 0; const original = camera.updateProjectionMatrix.bind(camera);
  camera.updateProjectionMatrix = () => { updates++; original(); };
  const near = depth.update(camera); depth.update(camera);
  assert.equal(updates, 1); assert.ok(near > 100);
  assert.deepEqual(camera.position.toArray(), eye.toArray()); assert.deepEqual(camera.quaternion.toArray(), rotation.toArray()); assert.equal(camera.far, far);
  assert.equal(MINIMUM_CAMERA_NEAR, .5, 'physical camera sphere uses the stable baseline near, never adaptive far-view clipping');
});
