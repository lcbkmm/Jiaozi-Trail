import * as T from './assets/vendor/three.module.js';

const float = new Float32Array(1), bits = new Uint32Array(float.buffer);
function inwardFloat(value, limit) {
  float[0] = Math.max(-limit, Math.min(limit, value));
  // GPU attributes use float32. Its nearest value can otherwise protrude by
  // one ULP beyond a previously audited box, even when the double is in bounds.
  if (Math.abs(float[0]) > limit) bits[0]--;
  return float[0];
}

function samples(half, radius, segments) {
  const core = half - radius, values = [];
  for (let i = segments; i >= 0; i--) values.push(-core - radius * Math.tan(i / segments * Math.PI / 4));
  for (let i = 0; i <= segments; i++) values.push(core + radius * Math.tan(i / segments * Math.PI / 4));
  return values.filter((value, i) => !i || value !== values[i - 1]);
}

/**
 * Smooth roundover wholly inside the original, centered box. Positions,
 * including float32 rounding, never exceed ±width/2, ±height/2 or ±depth/2.
 * Existing oriented collision/audit boxes therefore remain valid. Radius is
 * in world units before scaling; segments controls each half of a roundover.
 * Six groups follow BoxGeometry's +X, -X, +Y, -Y, +Z, -Z material ordering.
 */
export function roundedBoxGeometry(width = 1, height = 1, depth = 1,
  radius = Math.min(width, height, depth) * .12, segments = 4) {
  const size = [width, height, depth];
  if (!size.every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Rounded box dimensions must be finite and positive.');
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Rounded box radius must be finite and non-negative.');
  if (!Number.isFinite(segments)) throw new RangeError('Rounded box segments must be finite.');
  segments = Math.max(1, Math.min(12, Math.round(segments)));
  const half = size.map(value => value / 2);
  radius = Math.min(radius, ...half);
  if (!radius) {
    const geometry = new T.BoxGeometry(width, height, depth), position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) for (let axis = 0; axis < 3; axis++) position.array[i * 3 + axis] = inwardFloat(position.array[i * 3 + axis], half[axis]);
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return geometry;
  }

  const core = half.map(value => value - radius), axes = half.map(value => samples(value, radius, segments));
  const positions = [], normals = [], uvs = [], indices = [], groups = [];
  // fixed axis, side, U axis/direction, V axis/direction; cross(U,V) is outward.
  const faces = [[0, 1, 2, -1, 1, 1], [0, -1, 2, 1, 1, 1],
    [1, 1, 0, 1, 2, -1], [1, -1, 0, 1, 2, 1],
    [2, 1, 0, 1, 1, 1], [2, -1, 0, -1, 1, 1]];
  for (const [fixed, side, uAxis, uSign, vAxis, vSign] of faces) {
    const us = axes[uAxis], vs = axes[vAxis], startVertex = positions.length / 3, startIndex = indices.length;
    for (const v of vs) for (const u of us) {
      const outer = [0, 0, 0]; outer[fixed] = side * half[fixed]; outer[uAxis] = u * uSign; outer[vAxis] = v * vSign;
      const inner = outer.map((value, axis) => Math.max(-core[axis], Math.min(core[axis], value)));
      const delta = outer.map((value, axis) => value - inner[axis]), length = Math.hypot(...delta);
      const normal = delta.map(value => value / length);
      positions.push(...normal.map((value, axis) => inwardFloat(inner[axis] + value * radius, half[axis])));
      normals.push(...normal);
      uvs.push(u / size[uAxis] + .5, v / size[vAxis] + .5);
    }
    for (let y = 0; y < vs.length - 1; y++) for (let x = 0; x < us.length - 1; x++) {
      const a = startVertex + y * us.length + x, b = a + 1, c = a + us.length, d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
    groups.push({ start: startIndex, count: indices.length - startIndex, materialIndex: groups.length });
  }
  const geometry = new T.BufferGeometry(); geometry.type = 'RoundedBoxGeometry';
  geometry.parameters = { width, height, depth, radius, segments };
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
