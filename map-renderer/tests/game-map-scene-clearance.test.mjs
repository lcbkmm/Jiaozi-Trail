import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../assets/vendor/three.module.js';
import { buildBuildingTopology } from '../game-map-buildings.mjs';
import { exposedBuildingGeometry } from '../game-map-scene.mjs';

// The renderer stores positions as Float32, including the 0.24m world offset.
const near = (actual, expected, tolerance = 5e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const square = (west, north, east, south) => [[west, north], [east, north], [east, south], [west, south]];
const building = (id, ring, height = 10, base = 0) => ({ id, rings: [ring], displayHeight: height, displayBaseHeight: base, tags: {} });
function meshesOf(buildings) {
  const topology = buildBuildingTopology(buildings), material = new T.MeshBasicMaterial();
  const meshes = buildings.map(b => {
    const mesh = new T.Mesh(exposedBuildingGeometry(b, topology.get(b.id)), material);
    mesh.updateMatrixWorld(true); return mesh;
  });
  return { topology, meshes, dispose() { meshes.forEach(m => m.geometry.dispose()); material.dispose(); } };
}
const raycast = (meshes, origin, direction) => new T.Raycaster(new T.Vector3(...origin), new T.Vector3(...direction)).intersectObjects(meshes);
function surfaceArea(meshes, predicate) {
  let total = 0;
  for (const mesh of meshes) {
    const p = mesh.geometry.getAttribute('position'), n = mesh.geometry.getAttribute('normal');
    for (let i = 0; i < p.count; i += 3) {
      if (!predicate(new T.Vector3().fromBufferAttribute(n, i), new T.Vector3().fromBufferAttribute(p, i))) continue;
      const a = new T.Vector3().fromBufferAttribute(p, i), b = new T.Vector3().fromBufferAttribute(p, i + 1), c = new T.Vector3().fromBufferAttribute(p, i + 2);
      total += b.sub(a).cross(c.sub(a)).length() / 2;
    }
  }
  return total;
}

test('exposed shared-wall geometry has outward winding, correct material groups and no concealed party-wall triangles', () => {
  const a = building('a', square(0, 0, 10, 10)), b = building('b', square(10, 0, 20, 10), 20);
  const scene = meshesOf([a, b]);
  try {
    for (const mesh of scene.meshes) {
      const g = mesh.geometry, p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv');
      assert.equal(g.groups.reduce((sum, group) => sum + group.count, 0), p.count);
      assert.equal(g.groups[0].materialIndex, 0); assert.equal(g.groups[1].materialIndex, 1);
      assert.ok(Array.from(uv.array).every(Number.isFinite));
      for (let i = 0; i < p.count; i += 3) {
        const x = new T.Vector3().fromBufferAttribute(p, i), y = new T.Vector3().fromBufferAttribute(p, i + 1), z = new T.Vector3().fromBufferAttribute(p, i + 2);
        const face = y.sub(x).cross(z.sub(x)).normalize(), normal = new T.Vector3().fromBufferAttribute(n, i);
        assert.ok(face.dot(normal) > .99999, 'front-side culling must agree with the declared outward normal');
        if (Math.abs(normal.y) < .001 && [i, i + 1, i + 2].every(j => Math.abs(p.getX(j) - 10) < 1e-5)) {
          assert.ok([i, i + 1, i + 2].every(j => p.getY(j) >= 10.24 - 1e-5), 'only the taller exposed facade remains above the common wall');
        }
      }
    }
    near(surfaceArea(scene.meshes, n => n.y > .99), 200);
    near(surfaceArea(scene.meshes, n => Math.abs(n.y) < .01), 1000);
    const upper = raycast(scene.meshes, [5, 15, 4], [1, 0, 0])[0];
    assert.ok(upper, 'the taller facade must be visible from above the lower roof'); near(upper.point.x, 10);
    assert.equal(raycast(scene.meshes, [5, 5, 4], [1, 0, 0]).length, 0, 'the common wall must not exist as a hidden front-facing mesh');
  } finally { scene.dispose(); }
});

test('coplanar overlapping roofs are emitted once and retain exact source heights', () => {
  const scene = meshesOf([building('a', square(0, 0, 10, 10)), building('b', square(5, 0, 15, 10))]);
  try {
    near(surfaceArea(scene.meshes, n => n.y > .99), 150);
    near(surfaceArea(scene.meshes, n => Math.abs(n.y) < .01), 500);
    for (const [x, z] of [[2, 4], [7, 4], [12, 4]]) {
      const hits = raycast(scene.meshes, [x, 40, z], [0, -1, 0]);
      assert.equal(hits.length, 1, 'the overlap must not produce coplanar roof flicker'); near(hits[0].point.y, 10.24);
    }
  } finally { scene.dispose(); }
});

test('exposed suspended buildings keep an open passage, a downward underside and exact base elevation', () => {
  const scene = meshesOf([building('raised', square(0, 0, 10, 10), 20, 8)]);
  try {
    near(surfaceArea(scene.meshes, n => n.y < -.99), 100);
    near(surfaceArea(scene.meshes, n => n.y > .99), 100);
    near(surfaceArea(scene.meshes, n => Math.abs(n.y) < .01), 480);
    assert.equal(raycast(scene.meshes, [-5, 4, 4], [1, 0, 0]).length, 0);
    const under = raycast(scene.meshes, [4, 4, 4], [0, 1, 0])[0]; assert.ok(under); near(under.point.y, 8.24);
    const facade = raycast(scene.meshes, [-5, 12, 4], [1, 0, 0])[0]; assert.ok(facade); near(facade.point.x, 0);
  } finally { scene.dispose(); }
});

test('courtyard walls face the empty courtyard for either source ring winding', () => {
  for (const reverse of [false, true]) {
    const b = building('court', square(0, 0, 20, 20)); b.rings.push(square(5, 5, 15, 15));
    if (reverse) b.rings.forEach(ring => ring.reverse());
    const scene = meshesOf([b]);
    try {
      near(surfaceArea(scene.meshes, n => n.y > .99), 300);
      assert.equal(raycast(scene.meshes, [10, 40, 10], [0, -1, 0]).length, 0);
      for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const hit = raycast(scene.meshes, [10, 5, 10], direction)[0]; assert.ok(hit, 'all four courtyard walls must render from inside the courtyard'); near(hit.distance, 5);
      }
    } finally { scene.dispose(); }
  }
});
