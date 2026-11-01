// Camera collision uses the same local-meter building rings as the renderer.
// Roof envelopes include the rendered base, gables, parapets and roof fixtures.
import { pointInRing } from './game-map-model.mjs';

const EPS = 1e-7, SKIN = 1e-4;
const footprintCache = new WeakMap();
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

function footprint(building) {
  if (!building || !Array.isArray(building.rings) || !Number.isFinite(building.displayHeight)) return null;
  let shape = footprintCache.get(building);
  if (shape?.rings === building.rings) return shape;
  const rings = building.rings.filter(r => Array.isArray(r) && r.length >= 3);
  if (!rings.length) return null;
  const edges = [], bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (![...a, ...b].every(Number.isFinite)) continue;
    bounds[0] = Math.min(bounds[0], a[0]); bounds[1] = Math.min(bounds[1], a[1]);
    bounds[2] = Math.max(bounds[2], a[0]); bounds[3] = Math.max(bounds[3], a[1]);
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    if (length > EPS) edges.push({ a, b, dx, dz, length });
  }
  shape = { rings: building.rings, validRings: rings, edges, bounds };
  shape.roofAllowance = roofAllowance(building, shape);
  footprintCache.set(building, shape);
  return shape;
}

function nearestOnEdge(x, z, edge) {
  const u = Math.max(0, Math.min(1, ((x - edge.a[0]) * edge.dx + (z - edge.a[1]) * edge.dz) / edge.length ** 2));
  const qx = edge.a[0] + u * edge.dx, qz = edge.a[1] + u * edge.dz;
  return { x: qx, z: qz, distance: Math.hypot(x - qx, z - qz) };
}

function inSolid(x, z, shape) {
  return pointInRing([x, z], shape.validRings[0]) && !shape.validRings.slice(1).some(r => pointInRing([x, z], r));
}

function roofAllowance(building, shape) {
  if (building.tags?.['roof:shape'] === 'gabled') {
    // Match gabledRoofGeometry's ridge direction and span, including small roofs.
    const outer = shape.validRings[0]; let longest = 0, u = [1, 0];
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], b = outer[(i + 1) % outer.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length > longest) { longest = length; u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]; }
    }
    const values = outer.map(p => -p[0] * u[1] + p[1] * u[0]);
    return .27 + Math.min(4.2, (Math.max(...values) - Math.min(...values)) * .24);
  }
  const seed = [...String(building.id)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);
  const center = building.center;
  if (seed % 4 !== 0 && Array.isArray(center) && center.length >= 2 && center.slice(0, 2).every(Number.isFinite)) {
    // Match roofFixtureFits: a fixture needs its full footprint outside holes.
    let fits = true;
    for (let side = 0; fits && side < 4; side++) for (let i = 0; i <= 12; i++) {
      const t = i / 12, x = center[0] + (side % 2 ? (side === 1 ? .5 : -.5) : t - .5) * 5.5;
      const z = center[1] + (side % 2 ? t - .5 : side === 0 ? -.5 : .5) * 3.8;
      if (!inSolid(x, z, shape)) { fits = false; break; }
    }
    if (fits && !shape.validRings.slice(1).some(r => r.some(p => Math.abs(p[0] - center[0]) < 2.75 && Math.abs(p[1] - center[1]) < 1.9))) {
      // Ventilation top is h + 2.4 + 1.1/2; access cores are lower.
      return 3;
    }
  }
  // Flat cap/bevel reaches h+.42 and the parapet/ink reaches h+.49.
  return .5;
}

function withinFootprint(x, z, shape, radius) {
  const [minX, minZ, maxX, maxZ] = shape.bounds;
  if (x <= minX - radius || x >= maxX + radius || z <= minZ - radius || z >= maxZ + radius) return false;
  if (inSolid(x, z, shape)) return true;
  // Expanding all boundary segments also shrinks courtyard openings correctly.
  return radius > EPS && shape.edges.some(edge => nearestOnEdge(x, z, edge).distance < radius - EPS);
}

function addTime(times, t) {
  if (t > EPS && t < 1 - EPS && Number.isFinite(t)) times.push(t);
}

function boundaryTimes(start, end, shape, radius, roof, bottom) {
  const dx = end.x - start.x, dz = end.z - start.z, dy = end.y - start.y;
  const times = [0, 1], speed2 = dx * dx + dz * dz;
  if (Math.abs(dy) > EPS) {
    addTime(times, (roof - start.y) / dy);
    if (Number.isFinite(bottom)) addTime(times, (bottom - start.y) / dy);
  }
  for (const edge of shape.edges) {
    // Each edge's radius expansion is a capsule: parallel sides and end circles.
    const normalX = -edge.dz / edge.length, normalZ = edge.dx / edge.length;
    const distance = (start.x - edge.a[0]) * normalX + (start.z - edge.a[1]) * normalZ;
    const velocity = dx * normalX + dz * normalZ;
    if (Math.abs(velocity) > EPS) for (const side of [-radius, radius]) {
      const t = (side - distance) / velocity;
      const u = ((start.x + t * dx - edge.a[0]) * edge.dx + (start.z + t * dz - edge.a[1]) * edge.dz) / edge.length ** 2;
      if (u >= -EPS && u <= 1 + EPS) addTime(times, t);
    }
    if (radius > EPS && speed2 > EPS) {
      const px = start.x - edge.a[0], pz = start.z - edge.a[1];
      const b = 2 * (px * dx + pz * dz), c = px * px + pz * pz - radius * radius;
      const discriminant = b * b - 4 * speed2 * c;
      if (discriminant >= 0) {
        const root = Math.sqrt(discriminant);
        addTime(times, (-b - root) / (2 * speed2)); addTime(times, (-b + root) / (2 * speed2));
      }
    }
  }
  return times.sort((a, b) => a - b).filter((t, i, all) => !i || t - all[i - 1] > EPS);
}

function contactNormal(point, end, shape, roof, bottom) {
  if (end.y < point.y && Math.abs(point.y - roof) < SKIN) return { x: 0, y: 1, z: 0 };
  if (end.y > point.y && Math.abs(point.y - bottom) < SKIN) return { x: 0, y: -1, z: 0 };
  let nearest = null, nearestEdge = null;
  for (const edge of shape.edges) {
    const q = nearestOnEdge(point.x, point.z, edge);
    if (!nearest || q.distance < nearest.distance) { nearest = q; nearestEdge = edge; }
  }
  if (nearest?.distance > EPS) return { x: (point.x - nearest.x) / nearest.distance, y: 0, z: (point.z - nearest.z) / nearest.distance };
  // A radius of zero can contact the edge itself; choose its free-space normal.
  let x = -nearestEdge.dz / nearestEdge.length, z = nearestEdge.dx / nearestEdge.length;
  if (inSolid(point.x + x * SKIN, point.z + z * SKIN, shape)) { x = -x; z = -z; }
  return { x, y: 0, z };
}

function sweep(start, end, shapes, radius) {
  let nearest = null;
  for (const { shape, roof, bottom } of shapes) {
    if (Math.min(start.y, end.y) >= roof - EPS || Math.max(start.y, end.y) <= bottom + EPS) continue;
    const [minX, minZ, maxX, maxZ] = shape.bounds;
    if (Math.max(start.x, end.x) <= minX - radius || Math.min(start.x, end.x) >= maxX + radius
      || Math.max(start.z, end.z) <= minZ - radius || Math.min(start.z, end.z) >= maxZ + radius) continue;
    const times = boundaryTimes(start, end, shape, radius, roof, bottom);
    for (let i = 1; i < times.length; i++) {
      const t = times[i - 1];
      if (nearest && t >= nearest.t) break;
      const middle = lerp(start, end, (t + times[i]) / 2);
      if (middle.y < roof - EPS && middle.y > bottom + EPS && withinFootprint(middle.x, middle.z, shape, radius)) {
        const point = lerp(start, end, t);
        nearest = { t, normal: contactNormal(point, end, shape, roof, bottom) };
        break;
      }
    }
  }
  return nearest;
}

/**
 * Sweep the camera (meters, +Y up) against rendered building footprints.
 * Keep a near-plane clearance, slide along walls/roofs, and never tunnel through
 * a thin building even when both endpoints are outdoors. Courtyards remain open.
 * Returns a plain position object; input vectors and buildings are never changed.
 */
export function resolveCameraClearance(previous, desired, buildings, clearance = 1.2) {
  const radius = Number.isFinite(clearance) ? Math.max(0, clearance) : 1.2;
  const shapes = [];
  for (const building of buildings || []) {
    const shape = footprint(building);
    const base = Math.max(0, building.displayBaseHeight || 0);
    // Body geometry includes a .24m translation and a .18m lower bevel. A
    // suspended building has a real underside, so its open passage stays open.
    const bottom = base > 0 ? base + (building.tags?.['roof:shape'] === 'gabled' ? .24 : .06) - radius : -Infinity;
    if (shape?.edges.length) shapes.push({ shape, roof: building.displayHeight + shape.roofAllowance + radius, bottom });
  }
  let position = { x: previous.x, y: previous.y, z: previous.z };
  // Orbit/route mode changes can start embedded. Repair once before sweeping.
  for (let i = 0; i < shapes.length; i++) {
    let roof = position.y;
    for (const obstacle of shapes) if (position.y < obstacle.roof && position.y > obstacle.bottom
      && withinFootprint(position.x, position.z, obstacle.shape, radius)) roof = Math.max(roof, obstacle.roof + SKIN);
    if (roof === position.y) break;
    // Lifting out of one volume can enter a higher suspended volume. Repeat
    // until the camera clears the whole stack, independent of source order.
    position.y = roof;
  }
  let goal = { x: desired.x, y: desired.y, z: desired.z };
  for (let i = 0; i < 8; i++) {
    const hit = sweep(position, goal, shapes, radius);
    if (!hit) return goal;
    const contact = lerp(position, goal, hit.t), n = hit.normal;
    const remaining = { x: goal.x - contact.x, y: goal.y - contact.y, z: goal.z - contact.z };
    const into = remaining.x * n.x + remaining.y * n.y + remaining.z * n.z;
    position = { x: contact.x + n.x * SKIN, y: contact.y + n.y * SKIN, z: contact.z + n.z * SKIN };
    // Remove only the part directed into the obstacle; keep tangential motion.
    if (into < 0) { remaining.x -= into * n.x; remaining.y -= into * n.y; remaining.z -= into * n.z; }
    goal = { x: position.x + remaining.x, y: position.y + remaining.y, z: position.z + remaining.z };
    if (Math.hypot(remaining.x, remaining.y, remaining.z) < EPS) return position;
  }
  return position;
}
