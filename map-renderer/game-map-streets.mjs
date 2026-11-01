import clipping from './assets/vendor/polyclip-ts.mjs';

// All polygons use local metre X/Z coordinates. Only rendering topology is
// changed: source centre lines, building footprints and geographic data stay intact.
// Decimal arithmetic and a sub-micrometre collinearity tolerance keep shared
// source edges stable across repeated union/difference operations at junctions.
clipping.setPrecision(1e-14);
const { union, difference, intersection } = clipping;
export const STREET_TOPOLOGY_VERSION = 1;
// Streets/markings are at .14/.16m and the ground guidance band at .22m.
// An explicit suspended building body above all those surfaces must not cut
// them away. OSM layer is ordering metadata, never a metric bottom elevation.
const GROUND_SURFACE_HEIGHT = .22;
const STREET_TOPOLOGY_ALGORITHM = 'ground-solid-height-v2';
const snap = n => Math.round(n * 10000) / 10000;
const clean = rings => rings.map(r => r.map(p => p.map(snap)));
const cut = (a, b) => a.length && b.length ? difference(a, b) : a;
const meet = (a, b) => a.length && b.length ? intersection(a, b) : [];
function merge(polygons) {
  if (!polygons.length) return [];
  // Bound sweep-line queue size when a future district has many short ways.
  const groups = [];
  for (let i = 0; i < polygons.length; i += 100) groups.push(union(...polygons.slice(i, i + 100)));
  return groups.length === 1 ? groups[0] : union(...groups);
}
const enabled = value => value != null && !['no', '0', 'false', ''].includes(String(value).toLowerCase());

// Both the offline generator and browser verify the same normalized inputs.
// The format version describes the cache shape; the algorithm id additionally
// invalidates geometry generated under older rules without changing that shape.
export async function streetTopologySignature(model) {
  const input = JSON.stringify({
    version: STREET_TOPOLOGY_VERSION,
    algorithm: STREET_TOPOLOGY_ALGORITHM,
    bounds: model.bounds,
    roads: (model.roads || []).map(r => ({ road_class: r.road_class, tags: r.tags || {}, segments: r.segments })),
    buildings: (model.buildings || []).map(b => ({ rings: b.rings, displayBaseHeight: b.displayBaseHeight ?? 0 })),
    surfaces: (model.surfaces || []).map(s => ({ rings: s.rings, properties: s.properties })),
    route: model.route?.points || null,
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function isGroundBuilding(building) {
  const base = Number(building.displayBaseHeight ?? 0);
  return !Number.isFinite(base) || base <= GROUND_SURFACE_HEIGHT;
}
export function isGroundRoad(road) {
  const t = road.tags || {};
  return !(Number(t.layer || 0) !== 0 || Number(t.level || 0) !== 0
    || enabled(t.bridge) || enabled(t.tunnel) || enabled(t.indoor)
    || /roof|underground|indoor|elevated/.test(t.location || ''));
}
export function roadWidth(road) {
  const t = road.tags || {}, value = String(t.width || '').trim();
  if (/^\d+(\.\d+)?\s*(m|metres|meters)?$/.test(value)) {
    const width = parseFloat(value); if (width > 0) return Math.max(.6, Math.min(40, width));
  }
  return ({ primary: 19, secondary: 16, tertiary: 12, residential: 8, service: 5,
    pedestrian: 12, footway: 3.2, path: 2.8, steps: 3 })[road.road_class || t.highway] || 7;
}
function strip(a, b, width) {
  const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
  if (length < .001) return null;
  const nx = -dz / length * width / 2, nz = dx / length * width / 2;
  return clean([[[a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz],
    [b[0] - nx, b[1] - nz], [b[0] + nx, b[1] + nz]]]);
}
function circle(p, radius) {
  return clean([Array.from({ length: 32 }, (_, i) => {
    const angle = i * Math.PI / 16;
    return [p[0] + Math.cos(angle) * radius, p[1] + Math.sin(angle) * radius];
  })]);
}
function buffer(segments, width) {
  const shapes = [], joins = new Map();
  for (const [a, b] of segments) {
    const polygon = strip(a, b, width); if (!polygon) continue;
    shapes.push(polygon);
    for (const p of [a, b]) joins.set(`${snap(p[0])},${snap(p[1])}`, p);
  }
  for (const p of joins.values()) shapes.push(circle(p, width / 2));
  return merge(shapes);
}

export function buildStreetTopology(model) {
  const [w, n, e, s] = model.bounds;
  const boundary = [[[[w, n], [e, n], [e, s], [w, s]]]];
  const buildings = merge((model.buildings || []).filter(isGroundBuilding).map(b => b.rings));
  const openGround = cut(boundary, buildings);
  const clipGround = geometry => meet(geometry, openGround);
  const groundRoads = (model.roads || []).filter(isGroundRoad);
  const raw = { asphalt: [], pedestrian: [], curb: [], markings: [] };
  for (const road of groundRoads) {
    const kind = road.road_class || road.tags?.highway;
    const pedestrian = /^(pedestrian|footway|path|steps)$/.test(kind), width = roadWidth(road);
    raw[pedestrian ? 'pedestrian' : 'asphalt'].push(buffer(road.segments, width));
    raw.curb.push(buffer(road.segments, width + 2));
    if (pedestrian || width < 12) continue;
    for (const [a, b] of road.segments) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const at = d => [a[0] + (b[0] - a[0]) * d / length, a[1] + (b[1] - a[1]) * d / length];
      for (let d = 3; d < length - 4; d += 12) raw.markings.push(strip(at(d), at(d + 4), .3));
    }
  }
  // A single surface at junctions, including where footpaths cross a carriageway.
  // Curbs describe the network's outside edge, never each segment's internal edge.
  const rawAsphalt = merge(raw.asphalt), rawPedestrian = merge(raw.pedestrian);
  const roadFaces = merge([rawAsphalt, rawPedestrian]), occupied = merge(raw.curb);
  // Partition before intersecting the exact source building edges. Re-unioning
  // many already-cut, coincident edges needlessly amplifies floating point error.
  const asphalt = clipGround(rawAsphalt);
  const pedestrian = clipGround(cut(rawPedestrian, rawAsphalt));
  const curb = clipGround(cut(occupied, roadFaces));
  const markings = clipGround(meet(merge(raw.markings), rawAsphalt));
  const surfaceInputs = { water: [], green: [], paving: [] };
  for (const surface of model.surfaces || []) {
    const props = surface.properties || {}, tags = props.tags || {};
    if (!isGroundRoad({ tags })) continue;
    const type = props.kind === 'water' ? 'water'
      : /grass|park|garden|forest|recreation/.test([tags.landuse, tags.leisure, tags.natural].join(' ')) ? 'green' : 'paving';
    surfaceInputs[type].push(surface.rings);
  }
  const surfaces = {}, reserved = [occupied];
  for (const type of ['water', 'green', 'paving']) {
    let region = merge(surfaceInputs[type]);
    const original = region;
    for (const mask of reserved) region = cut(region, mask);
    surfaces[type] = clipGround(region);
    reserved.push(original);
  }
  let band = [], core = [];
  if (model.route?.points?.length > 1) {
    const segments = model.route.points.slice(1).map((p, i) => [model.route.points[i], p]);
    const rawCore = buffer(segments, .65);
    core = clipGround(rawCore);
    band = clipGround(cut(buffer(segments, 2.3), rawCore));
  }
  return { asphalt, pedestrian, curb, markings, surfaces, route: { band, core }, groundRoads,
    stats: { groundRoads: groundRoads.length, omittedNonGroundRoads: (model.roads || []).length - groundRoads.length,
      streetPolygons: asphalt.length + pedestrian.length + curb.length } };
}
