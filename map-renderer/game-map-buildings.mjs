import clipping from './assets/vendor/polyclip-ts.mjs';

// Source footprints stay unchanged. This module describes only surfaces exposed
// by the union of the supplied vertical building volumes, in local metre X/Z.
clipping.setPrecision(1e-14);
const EPS = 1e-8, AREA_EPS = 1e-8;
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const interpolate = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const overlaps = (a, b) => a[0] <= b[2] + EPS && a[2] >= b[0] - EPS
  && a[1] <= b[3] + EPS && a[3] >= b[1] - EPS;

function ringArea(ring) {
  const origin = ring[0];
  return ring.reduce((sum, point, i) => sum + cross(subtract(point, origin), subtract(ring[(i + 1) % ring.length], origin)), 0) / 2;
}
function polygonArea(polygons) {
  return polygons.reduce((sum, rings) => sum + Math.abs(ringArea(rings[0]))
    - rings.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0), 0);
}
function boundsOf(rings) {
  let w = Infinity, n = Infinity, e = -Infinity, s = -Infinity;
  for (const ring of rings) for (const [x, z] of ring) {
    w = Math.min(w, x); n = Math.min(n, z); e = Math.max(e, x); s = Math.max(s, z);
  }
  return [w, n, e, s];
}
function edgesOf(rings) {
  const edges = [];
  rings.forEach((ring, ringIndex) => {
    // The outer ring points out of its solid; hole walls point into the hole.
    const side = (ringArea(ring) >= 0 ? 1 : -1) * (ringIndex === 0 ? 1 : -1);
    ring.forEach((a, edgeIndex) => {
      const b = ring[(edgeIndex + 1) % ring.length], delta = subtract(b, a), length = Math.hypot(...delta);
      if (length <= EPS) return;
      edges.push({ a, b, ringIndex, edgeIndex, normal: [side * delta[1] / length, -side * delta[0] / length],
        length, bounds: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
    });
  });
  return edges;
}
function prepare(buildings) {
  const ids = new Set();
  return buildings.map(building => {
    if (building.id == null || ids.has(building.id)) throw new Error('Building topology requires unique building ids');
    ids.add(building.id);
    const bottom = building.displayBaseHeight || 0, top = building.displayHeight;
    if (!Number.isFinite(bottom) || !Number.isFinite(top) || top < bottom) throw new Error(`Invalid building height: ${building.id}`);
    if (!building.rings?.length || building.rings.some(ring => ring.length < 3 || ring.some(p => !p.slice(0, 2).every(Number.isFinite)))) {
      throw new Error(`Invalid building rings: ${building.id}`);
    }
    // Clipping a concave footprint to the district can leave opposite bridge
    // edges between disconnected pieces. They enclose no solid and are not
    // walls. Normalize only the derived topology; never replace source rings.
    const polygons = clipping.union(building.rings);
    return { source: building, id: building.id, key: String(building.id), rings: building.rings, polygons,
      bottom, top, bounds: boundsOf(building.rings), edges: edgesOf(building.rings), boundaryEdges: polygons.flatMap(edgesOf) };
  });
}
function pointOnSegment(point, a, b) {
  const delta = subtract(b, a), rel = subtract(point, a), length = Math.hypot(...delta);
  if (length <= EPS) return Math.hypot(...rel) <= EPS;
  if (Math.abs(cross(delta, rel)) > EPS * length) return false;
  const along = rel[0] * delta[0] + rel[1] * delta[1];
  return along >= -EPS * length && along <= length * length + EPS * length;
}
function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < a[0] + (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}
function pointLocation(point, building) {
  for (const edge of building.boundaryEdges) if (pointOnSegment(point, edge.a, edge.b)) return 0;
  return building.polygons.some(rings => inRing(point, rings[0]) && !rings.slice(1).some(ring => inRing(point, ring))) ? 1 : -1;
}
// Return parameters on the source wall at every crossing, including both ends
// of a shared collinear span. No coordinate snapping or footprint shrink occurs.
function intersectionParameters(a, b, c, d) {
  const r = subtract(b, a), s = subtract(d, c), q = subtract(c, a);
  const lr = Math.hypot(...r), ls = Math.hypot(...s), denominator = cross(r, s);
  if (lr <= EPS || ls <= EPS) return [];
  if (Math.abs(denominator) <= EPS * Math.max(lr, ls)) {
    if (Math.abs(cross(q, r)) > EPS * lr) return [];
    const square = lr * lr, t = (q[0] * r[0] + q[1] * r[1]) / square;
    const u = ((d[0] - a[0]) * r[0] + (d[1] - a[1]) * r[1]) / square;
    if (Math.min(t, u) > 1 + EPS / lr || Math.max(t, u) < -EPS / lr) return [];
    return [Math.max(0, Math.min(1, t)), Math.max(0, Math.min(1, u))];
  }
  const t = cross(q, s) / denominator, u = cross(q, r) / denominator;
  return t >= -EPS / lr && t <= 1 + EPS / lr && u >= -EPS / ls && u <= 1 + EPS / ls
    ? [Math.max(0, Math.min(1, t))] : [];
}
function subtractIntervals(bottom, top, masks) {
  const result = []; let cursor = bottom;
  masks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [lo, hi] of masks) {
    if (hi <= cursor + EPS || lo >= top - EPS) continue;
    if (lo > cursor + EPS) result.push([cursor, Math.min(lo, top)]);
    cursor = Math.max(cursor, hi);
    if (cursor >= top - EPS) break;
  }
  if (cursor < top - EPS) result.push([cursor, top]);
  return result;
}
function hidesWall(mid, edge, owner, neighbour) {
  const location = pointLocation(mid, neighbour);
  if (location !== 0) return location > 0;
  // Opposite solid sides form an internal party wall. Same-side coplanar
  // surfaces form one exterior wall, assigned to the stable smaller source id.
  for (const other of neighbour.boundaryEdges) if (pointOnSegment(mid, other.a, other.b)) {
    const alignment = edge.normal[0] * other.normal[0] + edge.normal[1] * other.normal[1];
    if (alignment < -.5 || alignment > .5 && neighbour.key < owner.key) return true;
  }
  return false;
}

/**
 * Map<source id, { roofs: MultiPolygon, walls, bottom, top }>.
 * Each wall is an exposed vertical rectangle over an exact source edge span.
 * Heights exclude the renderer's global ground offset. Ring and edge indices
 * refer to the original rings; a/b are the cut span, sourceA/sourceB its edge.
 */
export function buildBuildingTopology(buildings) {
  const prepared = prepare(buildings), result = new Map();
  for (const owner of prepared) {
    const neighbours = prepared.filter(other => other !== owner && other.top > other.bottom + EPS && overlaps(owner.bounds, other.bounds));
    const walls = [];
    if (owner.top > owner.bottom + EPS) for (const edge of owner.edges) {
      const candidates = neighbours.filter(other => other.top > owner.bottom + EPS && other.bottom < owner.top - EPS && overlaps(edge.bounds, other.bounds));
      const parameters = [0, 1];
      for (const otherEdge of owner.boundaryEdges) {
        if (overlaps(edge.bounds, otherEdge.bounds)) parameters.push(...intersectionParameters(edge.a, edge.b, otherEdge.a, otherEdge.b));
      }
      for (const other of candidates) for (const otherEdge of other.boundaryEdges) {
        if (overlaps(edge.bounds, otherEdge.bounds)) parameters.push(...intersectionParameters(edge.a, edge.b, otherEdge.a, otherEdge.b));
      }
      parameters.sort((a, b) => a - b);
      const cuts = parameters.filter((value, i) => !i || (value - parameters[i - 1]) * edge.length > EPS);
      for (let i = 1; i < cuts.length; i++) {
        const lo = cuts[i - 1], hi = cuts[i]; if ((hi - lo) * edge.length <= EPS) continue;
        const a = interpolate(edge.a, edge.b, lo), b = interpolate(edge.a, edge.b, hi), mid = interpolate(edge.a, edge.b, (lo + hi) / 2);
        const boundary = owner.boundaryEdges.find(other => pointOnSegment(mid, other.a, other.b));
        if (!boundary || owner.edges.find(other => pointOnSegment(mid, other.a, other.b)) !== edge) continue;
        const masks = candidates.filter(other => hidesWall(mid, boundary, owner, other)).map(other => [other.bottom, other.top]);
        for (const [bottom, top] of subtractIntervals(owner.bottom, owner.top, masks)) walls.push({ a, b, normal: [...boundary.normal], bottom, top,
          ringIndex: edge.ringIndex, edgeIndex: edge.edgeIndex, sourceA: [...edge.a], sourceB: [...edge.b] });
      }
    }
    let roofs = owner.top > owner.bottom + EPS ? owner.polygons.map(rings => rings.map(ring => ring.map(point => [...point]))) : [];
    for (const other of neighbours) {
      // A raised building only covers this roof when its solid reaches it.
      if (other.bottom > owner.top + EPS || other.top < owner.top - EPS) continue;
      if (other.top <= owner.top + EPS && other.key >= owner.key) continue;
      if (roofs.length) roofs = clipping.difference(roofs, other.polygons);
    }
    result.set(owner.id, { roofs, walls, bottom: owner.bottom, top: owner.top });
  }
  return result;
}

function boxFootprint({ position, size, yaw = 0 }) {
  const cosine = Math.cos(yaw), sine = Math.sin(yaw), [width, , depth] = size;
  // Matches Three.js rotation.y: local X maps to [cos(yaw), -sin(yaw)].
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => [
    position[0] + cosine * x * width / 2 + sine * z * depth / 2,
    position[2] - sine * x * width / 2 + cosine * z * depth / 2,
  ]);
}

function validateBox(box) {
  if (!box?.position?.length || box.position.length !== 3 || !box.position.every(Number.isFinite)
    || box.size?.length !== 3 || !box.size.every(v => Number.isFinite(v) && v > 0)
    || box.yaw != null && !Number.isFinite(box.yaw)) throw new Error('Clearance requires a finite oriented box with positive size');
}

/**
 * Exact horizontal polygon intersection plus vertical interval overlap for a
 * complete oriented box, including thin corners and buildings inside its area.
 * position is the box centre [x,y,z], size [width,height,depth], yaw radians.
 * fits(owner, box, {allowOwn:false}) rejects positive solid-volume intrusion;
 * allowOwn skips only that owner's source volume, never a neighbouring one.
 * Flush contact is allowed. This tests collision, not support on a roof.
 */
export function createBuildingClearance(buildings) {
  const prepared = prepare(buildings);
  return { footprint(box) { validateBox(box); return boxFootprint(box); },
    // Full area support, including a hole completely enclosed by the fixture.
    // Y and height are validated but deliberately irrelevant to this test.
    containsFootprint(owner, box) {
      validateBox(box);
      const source = prepared.find(other => other.source === owner || owner?.id != null && other.id === owner.id);
      if (!source) throw new Error('Footprint support requires a known owner building');
      return polygonArea(clipping.difference([[boxFootprint(box)]], source.polygons)) <= AREA_EPS;
    },
    fits(owner, box, { allowOwn = false } = {}) {
      validateBox(box);
      const footprint = boxFootprint(box), bounds = boundsOf([footprint]);
      const bottom = box.position[1] - box.size[1] / 2, top = box.position[1] + box.size[1] / 2;
      for (const other of prepared) {
        if (allowOwn && (other.source === owner || owner?.id != null && other.id === owner.id)) continue;
        if (other.top <= bottom + EPS || other.bottom >= top - EPS || !overlaps(bounds, other.bounds)) continue;
        if (polygonArea(clipping.intersection([[footprint]], other.polygons)) > AREA_EPS) return false;
      }
      return true;
    },
  };
}
