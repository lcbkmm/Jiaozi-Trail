import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../assets/vendor/three.module.js';
import { buildingInfo, pointInRing } from '../game-map-model.mjs';
import { buildingGeometry } from '../game-map-scene.mjs';
import { resolveCameraClearance } from '../game-map-collision.mjs';

const near = (a, b, tolerance = .001) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const point = (x, y, z) => ({ x, y, z });
const rectangle = (height = 20, base = 10) => ({ rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], displayHeight: height, displayBaseHeight: base, tags: {} });
const meshOf = building => {
  const mesh = new T.Mesh(buildingGeometry(building), new T.MeshBasicMaterial({ side: T.DoubleSide }));
  mesh.updateMatrixWorld(true); return mesh;
};
const dispose = mesh => { mesh.geometry.dispose(); mesh.material.dispose(); };

test('min_height is a base elevation and top/bottom elevations are compressed separately', () => {
  const b = buildingInfo({ height_m: 100, min_height_m: 50 });
  assert.equal(b.height, 100); assert.equal(b.baseHeight, 50);
  near(b.displayHeight, 55.8); near(b.displayBaseHeight, 39.8);
  const tagged = buildingInfo({ height_m: 20, tags: { min_height: '6' } });
  assert.equal(tagged.height, 20); assert.equal(tagged.baseHeight, 6); assert.equal(tagged.displayBaseHeight, 6);
  for (const min_height_m of [-5, 20, 40, NaN]) assert.equal(buildingInfo({ height_m: 20, min_height_m }).baseHeight, 0);
});

test('a high suspended part remains finite when both rendered elevations reach the display cap', () => {
  const b = buildingInfo({ height_m: 500, min_height_m: 450 });
  assert.equal(b.height, 500); assert.equal(b.baseHeight, 450);
  assert.ok(b.displayBaseHeight > 0 && b.displayBaseHeight < b.displayHeight);
  const mesh = meshOf({ ...rectangle(), ...b }); mesh.geometry.computeBoundingBox();
  assert.ok(mesh.geometry.boundingBox.min.y > 100); assert.ok(mesh.geometry.boundingBox.max.y > mesh.geometry.boundingBox.min.y);
  dispose(mesh);
});

test('suspended rendered walls start at min_height and do not fill the passage below', () => {
  const b = rectangle(), before = structuredClone(b), mesh = meshOf(b);
  mesh.geometry.computeBoundingBox();
  near(mesh.geometry.boundingBox.min.y, 10.06); near(mesh.geometry.boundingBox.max.y, 20.42);
  assert.deepEqual(b, before);
  const passage = new T.Raycaster(new T.Vector3(-5, 5, 5), new T.Vector3(1, 0, 0));
  assert.equal(passage.intersectObject(mesh).length, 0, 'a horizontal ray can pass beneath the suspended wall');
  passage.ray.origin.y = 15; assert.ok(passage.intersectObject(mesh).length > 0, 'the raised wall itself remains solid');
  const underside = new T.Raycaster(new T.Vector3(5, 5, 5), new T.Vector3(0, 1, 0)).intersectObject(mesh)[0];
  near(underside.point.y, 10.06); dispose(mesh);
});

test('rounding an L-shaped building never fills the original concave empty corner', () => {
  const b = { rings: [[[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]]], displayHeight: 12, tags: {} };
  const mesh = meshOf(b), pos = mesh.geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) assert.ok(!(pos.getX(i) > 5.001 && pos.getZ(i) > 5.001), 'no rounded wall or bevel vertex may enter the L-shaped void');
  const ray = new T.Raycaster(new T.Vector3(5.08, 40, 5.08), new T.Vector3(0, -1, 0));
  assert.equal(ray.intersectObject(mesh).length, 0);
  ray.ray.origin.set(4, 40, 4); assert.ok(ray.intersectObject(mesh).length > 0); dispose(mesh);
});

test('courtyard corner openings remain exact after smoothing outer building corners', () => {
  const b = { ...rectangle(12, 0), rings: [[[0, 0], [20, 0], [20, 20], [0, 20]], [[5, 5], [15, 5], [15, 15], [5, 15]]] };
  const mesh = meshOf(b), ray = new T.Raycaster(new T.Vector3(5.04, 40, 5.04), new T.Vector3(0, -1, 0));
  assert.ok(pointInRing([5.04, 5.04], b.rings[1]));
  assert.equal(ray.intersectObject(mesh).length, 0, 'a rounded courtyard must not cover its original corner');
  ray.ray.origin.set(10, 40, 10); assert.equal(ray.intersectObject(mesh).length, 0); dispose(mesh);
});

test('narrow convex parcels keep all rounded wall vertices within their surveyed footprint', () => {
  // Actual narrow corners in two Chunxi parcels previously inverted the bevel
  // miter and extended the facade 3–5 cm into adjacent open space.
  const parcels = [
    [[0, 0], [36.5511, 14.6051], [5.1039, -9.2729], [2.8249, -8.7274], [1.0533, -5.3656], [0, -3.3396]],
    [[0, 0], [3.409, -5.7441], [-4.0123, -10.0522], [-4.0366, -10.0102], [-4.0366, -2.383]]
  ];
  for (const ring of parcels) {
    const mesh = meshOf({ rings: [ring], displayHeight: 12, tags: {} }), position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const p = [position.getX(i), position.getZ(i)];
      if (pointInRing(p, ring)) continue;
      const distance = Math.min(...ring.map((a, j) => {
        const b = ring[(j + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1], square = dx * dx + dz * dz;
        const t = square ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / square)) : 0;
        return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
      }));
      assert.ok(distance <= .001, `a narrow facade vertex escaped its footprint by ${distance} m`);
    }
    dispose(mesh);
  }
});

test('cameras can move and remain stationary under a suspended building', () => {
  const b = rectangle(), previous = point(-5, 5, 5), desired = point(15, 5, 5);
  assert.deepEqual(resolveCameraClearance(previous, desired, [b]), desired);
  const stationary = point(5, 5, 5);
  assert.deepEqual(resolveCameraClearance(stationary, stationary, [b]), stationary);
});

test('upward motion stops at the underside with near-plane clearance, even when the destination is above the roof', () => {
  const hit = resolveCameraClearance(point(5, 5, 5), point(5, 40, 5), [rectangle()]);
  near(hit.x, 5); near(hit.z, 5); near(hit.y, 8.86);
  const stationary = resolveCameraClearance(hit, hit, [rectangle()]); assert.deepEqual(stationary, hit);
});

test('the raised building wall blocks lateral movement at its actual height', () => {
  const hit = resolveCameraClearance(point(-5, 15, 5), point(15, 15, 5), [rectangle()]);
  near(hit.x, -1.2); near(hit.y, 15); near(hit.z, 5);
});

test('embedded recovery clears stacked suspended volumes regardless of input order', () => {
  const lower = rectangle(35, 0), higher = rectangle(50, 30), p = point(5, 5, 5);
  const a = resolveCameraClearance(p, p, [higher, lower]), b = resolveCameraClearance(p, p, [lower, higher]);
  near(a.y, 51.7); near(b.y, 51.7); near(a.x, p.x); near(a.z, p.z);
});
