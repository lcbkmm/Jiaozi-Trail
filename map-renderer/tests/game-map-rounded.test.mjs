import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../assets/vendor/three.module.js';
import { roundedBoxGeometry } from '../game-map-rounded.mjs';

const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('roundovers stay wholly inside audited dimensions, including float32 attributes', () => {
  for (const size of [[1, 1, 1], [5.2, 2.4, 3.5], [24.3, .36, .24], [.06, .1, .03]]) for (const radius of [0, .04, .12, 100]) {
    const geometry = roundedBoxGeometry(...size, radius), positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(positions.array[i * 3 + axis]) <= size[axis] / 2, `escaped ${size} radius ${radius}, axis ${axis}`);
    }
    const extent = geometry.boundingBox.getSize(new T.Vector3()).toArray();
    extent.forEach((value, axis) => { assert.ok(value <= size[axis]); near(value, size[axis]); });
    assert.ok(Number.isFinite(geometry.boundingSphere.radius));
    geometry.dispose();
  }
});

test('rounded surfaces are outward, non-degenerate and share continuous edge normals', () => {
  for (const radius of [.12, .5]) {
    const geometry = roundedBoxGeometry(1, 1, 1, radius, 4), p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
    const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), normal = new T.Vector3(), edgeNormals = new Map();
    for (let i = 0; i < p.count; i++) {
      normal.fromBufferAttribute(n, i); near(normal.length(), 1);
      const key = [p.getX(i), p.getY(i), p.getZ(i)].map(value => value.toFixed(7)).join(',');
      if (edgeNormals.has(key)) assert.ok(normal.distanceTo(edgeNormals.get(key)) < 1e-6, 'a smooth edge cannot have a visible normal seam');
      else edgeNormals.set(key, normal.clone());
    }
    for (let i = 0; i < geometry.index.count; i += 3) {
      const ai = geometry.index.getX(i), bi = geometry.index.getX(i + 1), ci = geometry.index.getX(i + 2);
      a.fromBufferAttribute(p, ai); b.fromBufferAttribute(p, bi); c.fromBufferAttribute(p, ci);
      const cross = b.sub(a).cross(c.sub(a));
      assert.ok(cross.length() > 1e-10, 'roundover cannot contain a zero-area triangle');
      assert.ok(cross.dot(normal.fromBufferAttribute(n, ai)) > 0, 'winding must face the exterior');
    }
    assert.ok(n.array.some(value => Math.abs(value) > .01 && Math.abs(value) < .99), 'roundovers need intermediate smooth normals');
    geometry.dispose();
  }
});

test('material groups and UVs remain usable as a six-face box replacement', () => {
  const geometry = roundedBoxGeometry(3, 2, 1, .1, 3), uv = geometry.getAttribute('uv');
  assert.deepEqual(geometry.groups.map(group => group.materialIndex), [0, 1, 2, 3, 4, 5]);
  assert.equal(geometry.groups.reduce((total, group) => total + group.count, 0), geometry.index.count);
  assert.equal(uv.count, geometry.getAttribute('position').count);
  for (const value of uv.array) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  assert.ok(geometry.getAttribute('position').count <= 600, 'shared decorations should not carry excessive geometry');
  geometry.dispose();
});

test('radius and detail limits avoid malformed geometry and invalid inputs fail explicitly', () => {
  const tiny = roundedBoxGeometry(1, .1, 2, 50, 0); near(tiny.parameters.radius, .05); assert.equal(tiny.parameters.segments, 1); tiny.dispose();
  const detailed = roundedBoxGeometry(1, 1, 1, .1, 10000); assert.equal(detailed.parameters.segments, 12); detailed.dispose();
  for (const args of [[0, 1, 1], [1, -1, 1], [Infinity, 1, 1], [1, 1, NaN], [1, 1, 1, -1], [1, 1, 1, Infinity], [1, 1, 1, .1, NaN]]) {
    assert.throws(() => roundedBoxGeometry(...args), RangeError);
  }
});
