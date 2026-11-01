// Geographic scene preparation. Distances are local meters; north is -Z.
const R = 6378137, DEG = Math.PI / 180;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function createProjection(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
      || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error('地图范围无效');
  const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const sx = R * DEG * Math.cos(center[1] * DEG), sy = R * DEG;
  const project = ([lng, lat]) => [(lng - center[0]) * sx, -(lat - center[1]) * sy];
  const unproject = ([x, z]) => [center[0] + x / sx, center[1] - z / sy];
  const [west, south] = project(bbox.slice(0, 2)), [east, north] = project(bbox.slice(2));
  return { center, project, unproject, bounds: [west, north, east, south],
    contains: p => p?.length >= 2 && p.slice(0, 2).every(Number.isFinite)
      && p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3] };
}
export function area(ring) {
  return ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
}
export function clipRing(points, bounds) {
  let out = points.filter(p => p.length >= 2 && p.slice(0, 2).every(Number.isFinite)).map(p => p.slice(0, 2));
  if (out.length > 1 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) < 1e-7) out.pop();
  for (const [axis, limit, sign] of [[0, bounds[0], 1], [0, bounds[2], -1], [1, bounds[1], 1], [1, bounds[3], -1]]) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const ain = (a[axis] - limit) * sign >= 0, bin = (b[axis] - limit) * sign >= 0;
      if (ain) out.push(a);
      if (ain !== bin) { const t = (limit - a[axis]) / (b[axis] - a[axis]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
  }
  out = out.filter((p, i) => !i || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-5);
  return out.length >= 3 && Math.abs(area(out)) > .5 ? out : [];
}
export function clipLine(a, b, bounds) {
  const dx = b[0] - a[0], dz = b[1] - a[1]; let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, a[0] - bounds[0]], [dx, bounds[2] - a[0]], [-dz, a[1] - bounds[1]], [dz, bounds[3] - a[1]]]) {
    if (!p) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [[a[0] + lo * dx, a[1] + lo * dz], [a[0] + hi * dx, a[1] + hi * dz]];
}
export function pointInRing([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function interiorPoint(rings) {
  const ring = rings[0], xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
  const valid = p => pointInRing(p, ring) && !rings.slice(1).some(h => pointInRing(p, h));
  let result = [ring[0][0], ring[0][1]], longest = -1;
  for (const fraction of [.5, .3, .7, .15, .85]) {
    const z = Math.min(...zs) + (Math.max(...zs) - Math.min(...zs)) * fraction, intersections = [];
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if ((a[1] > z) !== (b[1] > z)) intersections.push(a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 1; i < intersections.length; i++) {
      const p = [(intersections[i - 1] + intersections[i]) / 2, z], d = intersections[i] - intersections[i - 1];
      if (d > longest && valid(p)) { longest = d; result = p; }
    }
  }
  return result;
}
export function buildingInfo(properties) {
  const tags = properties.tags || {}, raw = Number(properties.height_m), levels = Number(tags['building:levels']);
  const known = Number.isFinite(raw) && raw > 0;
  const height = known ? raw : levels > 0 && Number.isFinite(levels) ? levels * 3 : 12;
  const heightSource = known ? properties.height_source || 'osm_height' : levels > 0 ? 'estimated_from_levels_3m' : 'visual_estimate';
  const estimated = /estimated|visual/.test(heightSource) || /estimated|approx/i.test(tags['source:height'] || '');
  const compress = value => Math.min(110, value > 35 ? 35 + (value - 35) * .32 : value);
  const displayHeight = Math.max(7, compress(height));
  const minHeight = Number(properties.min_height_m ?? tags.min_height);
  // OSM height is the total top elevation, never the wall thickness above min_height.
  const baseHeight = Number.isFinite(minHeight) && minHeight > 0 && minHeight < height ? minHeight : 0;
  // Compress both elevations with the same function. A small minimum wall span
  // keeps a very high suspended part visible when both elevations hit the cap.
  const displayBaseHeight = Math.min(Math.max(0, displayHeight - .1), compress(baseHeight));
  return { name: properties.name || '未命名建筑', named: Boolean(properties.name), height, displayHeight, baseHeight, displayBaseHeight, heightSource, estimated,
    levels: levels > 0 && Number.isFinite(levels) ? levels : null, source: properties.source || 'OpenStreetMap',
    updated: properties.source_updated_at || '', use: tags.shop === 'mall' ? '购物中心' : tags.building || '建筑',
    sourceHeight: tags['source:height'] || null, tags };
}
export function prepareScene(geojson, hotspots = { hotspots: [] }, routeData = null) {
  if (geojson?.metadata?.coordinate_system !== 'WGS84') throw new Error('场景需要 WGS84 坐标');
  const bbox = geojson.metadata.requested_bbox_wgs84;
  const projection = createProjection(bbox), { project, bounds } = projection;
  const buildings = [], roads = [], surfaces = [];
  for (const f of geojson.features || []) {
    const p = f.properties || {}, g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString' && p.kind === 'road') {
      const points = g.coordinates.map(project), segments = [];
      for (let i = 1; i < points.length; i++) { const line = clipLine(points[i - 1], points[i], bounds); if (line) segments.push(line); }
      if (segments.length) roads.push({ ...p, segments });
      continue;
    }
    if (!['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    for (const [index, polygon] of (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).entries()) {
      const rings = polygon.map(r => clipRing(r.map(project), bounds));
      if (!rings[0].length) continue;
      const shape = { id: `${p.osm_type || 'shape'}-${p.osm_id}-${index}`, rings: [rings[0], ...rings.slice(1).filter(r => r.length)], properties: p };
      shape.center = interiorPoint(shape.rings);
      if (p.kind === 'building') buildings.push({ ...shape, ...buildingInfo(p) });
      else surfaces.push(shape);
    }
  }
  const seen = new Set();
  // Read POIs directly from the geographic snapshot. An image export can omit
  // same-name stations/roads, so it must not be the authority for 3D positions.
  const sourcePlaces = (geojson.features || []).filter(f => f.properties?.kind === 'poi' && f.geometry?.type === 'Point')
    .map(f => ({ id: String(f.properties.uid || f.id), name: f.properties.name, coordinate: f.geometry.coordinates,
      coordinateSystem: 'WGS84', source: f.properties.source, address: f.properties.address,
      sourceBD09: f.properties.source_crs === 'BD09LL' ? f.properties.source_coordinates : null }));
  const places = [...sourcePlaces, ...(hotspots.hotspots || [])]
    .filter(p => {
      const id = String(p.id || `${p.name}:${p.coordinate}`);
      if (p.coordinateSystem !== 'WGS84' || !projection.contains(p.coordinate) || seen.has(id)) return false;
      seen.add(id); return true;
    })
    .map(p => ({ ...p, position: project(p.coordinate) }));
  const route = routeData?.available && routeData.coordinateSystem === 'WGS84'
    && routeData.coordinates?.length > 1 && routeData.coordinates.every(p => projection.contains(p))
    ? { ...routeData, points: routeData.coordinates.map(project) } : null;
  return { projection, bbox, bounds, buildings, roads, surfaces, places, route };
}
export function createRouteSampler(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances.at(-1) + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const length = distances.at(-1);
  return { length, at(distance) {
    const d = clamp(distance, 0, length);
    let i = 1; while (i < distances.length - 1 && distances[i] < d) i++;
    const a = points[i - 1], b = points[i], t = (d - distances[i - 1]) / (distances[i] - distances[i - 1] || 1);
    return { position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], direction: [b[0] - a[0], b[1] - a[1]] };
  } };
}
export function clampCameraTarget(target, position, bounds) {
  const x = clamp(target.x, bounds[0] + 5, bounds[2] - 5), z = clamp(target.z, bounds[1] + 5, bounds[3] - 5);
  position.x += x - target.x; position.z += z - target.z;
  target.x = x; target.z = z;
  return target;
}
