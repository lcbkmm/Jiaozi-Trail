import * as T from './assets/vendor/three.module.js';
import { clipLine, clipRing, pointInRing } from './game-map-model.mjs';
import { gcjToWgs } from './projection.mjs';

const EPS = 1e-5;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const copy = point => [...point];
const same = (a, b) => a && b && distance(a, b) <= EPS;
const validPosition = point => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite);
const inBounds = (point, bounds) => point[0] >= bounds[0] - EPS && point[0] <= bounds[2] + EPS
  && point[1] >= bounds[1] - EPS && point[1] <= bounds[3] + EPS;
const length = points => points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);

function coordinateOf(point, coordinateSystem = 'gcj02') {
  if (String(coordinateSystem).toLowerCase().replace(/[-_]/g, '') !== 'gcj02') return null;
  const lng = point?.longitude, lat = point?.latitude;
  if (![lng, lat].every(Number.isFinite) || Math.abs(lng) > 180 || Math.abs(lat) > 85) return null;
  return gcjToWgs(lng, lat);
}
function stopBaseHeight(position, buildings = []) {
  let height = .32;
  for (const building of buildings) {
    if (!building.rings?.[0]?.length || !pointInRing(position, building.rings[0])
      || building.rings.slice(1).some(ring => pointInRing(position, ring))) continue;
    const roofRise = building.tags?.['roof:shape'] === 'gabled' ? 4.2 : 0;
    height = Math.max(height, (building.displayHeight || 0) + roofRise + .32);
  }
  return height;
}

/**
 * Convert the planner's GCJ02 walking polylines into this WGS84 district.
 * Each run is one contiguous, in-bounds part of ONE leg. Out-of-district
 * portions, invalid points, and separate legs are never joined together.
 * coordinate means WGS84; original longitude/latitude/coord_system stay intact.
 */
export function preparePlanningRoute(route, places = [], model) {
  if (!model?.projection?.project || !Array.isArray(model.bounds) || model.bounds.length !== 4
    || !model.bounds.every(Number.isFinite)) throw new Error('规划路线需要有效地图投影及范围');
  const bounds = [...model.bounds], runs = [], exits = [], warnings = [];
  const byId = new Map((places || []).filter(Boolean).map(place => [String(place.place_id ?? place.id), place]));
  const stops = (route?.stops || []).map((stop, index) => {
    const id = String(stop.place_id ?? stop.id ?? stop.stop_id ?? index), place = byId.get(id) || {};
    const coordinate = coordinateOf(place, place.coord_system ?? 'gcj02');
    const position = coordinate ? model.projection.project(coordinate) : null;
    const inside = validPosition(position) && inBounds(position, bounds);
    if (!coordinate) warnings.push(`地点 ${stop.name || place.name || id} 缺少有效 GCJ02 坐标，未添加地图标记。`);
    return { ...place, ...stop, id, name: stop.name || place.name || id, sequence: index + 1,
      coordinate, position, inside, coordinateSystem: 'WGS84',
      sourceCoordinate: coordinate ? [place.longitude, place.latitude] : null, sourceCoordinateSystem: 'GCJ02',
      markerBaseHeight: inside ? stopBaseHeight(position, model.buildings) : null };
  });
  for (const [legIndex, leg] of (route?.legs || []).entries()) {
    const fromPlaceId = leg.from_place_id, toPlaceId = leg.to_place_id;
    if (String(leg.coord_system ?? 'gcj02').toLowerCase().replace(/[-_]/g, '') !== 'gcj02') {
      warnings.push(`路线第 ${legIndex + 1} 段不是 GCJ02，未绘制。`); continue;
    }
    const points = (leg.points || []).map(point => {
      const coordinate = coordinateOf(point, leg.coord_system);
      return coordinate ? model.projection.project(coordinate) : null;
    });
    if (points.some(point => !validPosition(point))) warnings.push(`路线第 ${legIndex + 1} 段含无效坐标，已在断点处分开显示。`);
    let current = null, pendingEntry = null;
    const event = (position, direction, kind) => ({ position: copy(position), direction: copy(direction), fromPlaceId, toPlaceId, legIndex, kind });
    const finish = exit => {
      if (current?.points.length >= 2) {
        current.length = length(current.points);
        if (current.length > EPS) {
          if (exit) current.exit = exit;
          current.index = runs.length; runs.push(current);
          if (current.entry) exits.push(current.entry);
          if (current.exit) exits.push(current.exit);
        }
      }
      current = null;
    };
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (!validPosition(a) || !validPosition(b)) { finish(); pendingEntry = null; continue; }
      const size = distance(a, b); if (size <= EPS) continue;
      const direction = [(b[0] - a[0]) / size, (b[1] - a[1]) / size];
      const aInside = inBounds(a, bounds), bInside = inBounds(b, bounds), clipped = clipLine(a, b, bounds);
      if (!clipped || distance(...clipped) <= EPS) {
        // A vertex may lie exactly on the boundary. Its following segment can
        // leave without contributing any positive-length in-district geometry.
        finish(current && aInside && !bInside && same(current.points.at(-1), a) ? event(a, direction, 'exit') : null);
        pendingEntry = !aInside && bInside ? event(b, direction, 'entry') : null;
        continue;
      }
      if (current && !same(current.points.at(-1), clipped[0])) finish();
      if (!current) {
        current = { points: [copy(clipped[0])], fromPlaceId, toPlaceId, legIndex,
          source: leg.source, delivery: leg.delivery };
        const entry = !aInside ? event(clipped[0], direction, 'entry') : pendingEntry;
        if (entry) current.entry = entry;
      }
      if (!same(current.points.at(-1), clipped[1])) current.points.push(copy(clipped[1]));
      pendingEntry = null;
      if (!bInside) finish(event(clipped[1], direction, 'exit'));
    }
    finish();
  }
  return { runs, stops, exits, bounds, totalLength: runs.reduce((sum, run) => sum + run.length, 0),
    coordinateSystem: 'WGS84', routeId: route?.route_id ?? null,
    hasOutside: exits.length > 0 || stops.some(stop => stop.position && !stop.inside), warnings };
}

function routeBand(points, width, bounds, y) {
  const vertices = [], radius = width / 2;
  const add = ring => {
    const polygon = bounds ? clipRing(ring, bounds) : ring;
    for (let i = 1; i < polygon.length - 1; i++) for (const p of [polygon[0], polygon[i], polygon[i + 1]]) vertices.push(p[0], y, p[1]);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], size = distance(a, b); if (size <= EPS) continue;
    const nx = -(b[1] - a[1]) / size * radius, nz = (b[0] - a[0]) / size * radius;
    add([[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]]);
  }
  for (const point of points) add(Array.from({ length: 20 }, (_, i) => {
    const angle = i / 20 * Math.PI * 2; return [point[0] + Math.cos(angle) * radius, point[1] + Math.sin(angle) * radius];
  }));
  const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals(); return geometry;
}

// Rounded stroke digits make a crisp, camera-facing numbered badge without a
// webfont, DOM, texture download, or browser-only canvas dependency.
const DIGITS = [
  [[[.5, .08], [.23, .1], [.12, .3], [.12, .7], [.24, .9], [.5, .92], [.75, .88], [.86, .68], [.86, .3], [.75, .1], [.5, .08]]],
  [[[.24, .26], [.52, .08], [.52, .9]], [[.24, .9], [.8, .9]]],
  [[[.14, .25], [.26, .1], [.64, .1], [.84, .25], [.84, .4], [.16, .9], [.86, .9]]],
  [[[.14, .15], [.72, .1], [.86, .25], [.75, .43], [.48, .48], [.75, .5], [.86, .67], [.8, .84], [.58, .92], [.18, .87]]],
  [[[.68, .92], [.68, .08], [.1, .65], [.91, .65]]],
  [[[.83, .1], [.2, .1], [.16, .48], [.64, .45], [.84, .6], [.84, .78], [.64, .91], [.19, .87]]],
  [[[.78, .12], [.43, .1], [.2, .28], [.13, .65], [.2, .85], [.48, .92], [.78, .85], [.87, .65], [.76, .49], [.48, .45], [.17, .55]]],
  [[[.12, .11], [.88, .11], [.36, .91]]],
  [[[.5, .08], [.22, .13], [.14, .31], [.24, .44], [.75, .54], [.86, .72], [.77, .87], [.49, .92], [.22, .86], [.12, .7], [.22, .55], [.75, .44], [.84, .28], [.75, .12], [.5, .08]]],
  [[[.83, .47], [.53, .53], [.24, .48], [.13, .3], [.23, .13], [.49, .08], [.76, .15], [.87, .36], [.79, .72], [.57, .9], [.24, .88]]],
];
function badgeTexture(number) {
  const size = 128, data = new Uint8Array(size * size * 4), digits = String(number).split(''), paths = [];
  const glyphWidth = digits.length === 1 ? .32 : .25, glyphHeight = .52;
  const totalWidth = glyphWidth * digits.length + .035 * (digits.length - 1), left = (.98 - totalWidth) / 2;
  digits.forEach((digit, index) => DIGITS[Number(digit)].forEach(path => paths.push(path.map(([x, y]) => [left + (glyphWidth + .035) * index + x * glyphWidth, .24 + y * glyphHeight]))));
  const segmentDistance = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], square = dx * dx + dy * dy;
    const t = square ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / square)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = [(x + .5) / size, (y + .5) / size], radius = Math.hypot(p[0] - .5, p[1] - .5), index = (y * size + x) * 4;
    const alpha = Math.max(0, Math.min(1, (.478 - radius) * size));
    let color = radius > .425 ? [224, 166, 67] : [255, 246, 217], nearest = Infinity;
    for (const path of paths) for (let i = 1; i < path.length; i++) nearest = Math.min(nearest, segmentDistance(p, path[i - 1], path[i]));
    const stroke = Math.max(0, Math.min(1, (.022 - nearest) * size + .5));
    color = color.map((channel, c) => Math.round(channel * (1 - stroke) + [32, 65, 70][c] * stroke));
    data.set([...color, Math.round(alpha * 255)], index);
  }
  const texture = new T.DataTexture(data, size, size); texture.colorSpace = T.SRGBColorSpace;
  texture.flipY = true; texture.needsUpdate = true; texture.magFilter = T.LinearFilter; return texture;
}
const tagTree = (root, key, value) => root.traverse(node => { node.userData[key] = value; });

/** In-district guidance only. Normal depth testing retains building occlusion. */
export function createPlanningRouteOverlay(data) {
  const root = new T.Group(); root.name = 'planning-route'; root.userData.planningRoute = data;
  const bandMaterial = new T.MeshBasicMaterial({ color: '#d29c46', side: T.DoubleSide, toneMapped: false });
  const coreMaterial = new T.MeshBasicMaterial({ color: '#fff0b5', side: T.DoubleSide, toneMapped: false });
  const tealMaterial = new T.MeshBasicMaterial({ color: '#278c89', toneMapped: false });
  const goldMaterial = new T.MeshBasicMaterial({ color: '#e3ad51', toneMapped: false });
  const ringGeometry = new T.TorusGeometry(2.7, .2, 6, 40);
  const stemGeometry = new T.CylinderGeometry(.12, .12, 3.2, 8);
  const tipGeometry = new T.ConeGeometry(.7, 1.4, 14);
  const beaconGeometry = new T.OctahedronGeometry(1.1);
  const textures = new Set(), geometries = new Set([ringGeometry, stemGeometry, tipGeometry, beaconGeometry]);
  const materials = new Set([bandMaterial, coreMaterial, tealMaterial, goldMaterial]);
  for (const run of data.runs || []) {
    if (run.points?.length < 2) continue;
    const group = new T.Group(); group.name = `planning-run-${run.index}`; group.userData.planningRun = run;
    for (const [width, y, material] of [[4.4, .3, bandMaterial], [2.4, .32, coreMaterial]]) {
      const geometry = routeBand(run.points, width, data.bounds, y); geometries.add(geometry);
      group.add(new T.Mesh(geometry, material));
    }
    root.add(group);
  }
  for (const stop of data.stops || []) {
    if (!stop.inside || !validPosition(stop.position)) continue;
    const group = new T.Group(); group.name = `planning-stop-${stop.id}`;
    group.position.set(stop.position[0], stop.markerBaseHeight ?? .32, stop.position[1]);
    const ring = new T.Mesh(ringGeometry, goldMaterial); ring.rotation.x = -Math.PI / 2; ring.position.y = .1;
    const tip = new T.Mesh(tipGeometry, goldMaterial); tip.rotation.z = Math.PI; tip.position.y = 1.2;
    const stem = new T.Mesh(stemGeometry, goldMaterial); stem.position.y = 3.4;
    const texture = badgeTexture(stop.sequence || 1); textures.add(texture);
    const material = new T.SpriteMaterial({ map: texture, transparent: true, alphaTest: .02, toneMapped: false }); materials.add(material);
    const badge = new T.Sprite(material); badge.scale.set(13, 13, 1); badge.position.y = 10; badge.userData.sequence = stop.sequence;
    group.add(ring, tip, stem, badge); tagTree(group, 'planningStop', stop); root.add(group);
  }
  for (const exit of data.exits || []) {
    if (!validPosition(exit.position) || !validPosition(exit.direction)) continue;
    const group = new T.Group(); group.name = `planning-${exit.kind || 'exit'}-${exit.legIndex}`;
    group.position.set(exit.position[0], .4, exit.position[1]);
    const material = exit.kind === 'entry' ? tealMaterial : goldMaterial;
    const ring = new T.Mesh(ringGeometry, material); ring.rotation.x = -Math.PI / 2;
    const stem = new T.Mesh(stemGeometry, material); stem.position.y = 2;
    const beacon = new T.Mesh(beaconGeometry, material); beacon.position.y = 4.8;
    const arrow = new T.Mesh(tipGeometry, material); arrow.position.set(exit.direction[0] * 2.8, .3, exit.direction[1] * 2.8);
    arrow.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), new T.Vector3(exit.direction[0], 0, exit.direction[1]).normalize());
    group.add(ring, stem, beacon, arrow); tagTree(group, 'planningExit', exit); root.add(group);
  }
  let disposed = false;
  return { root, dispose() {
    if (disposed) return; disposed = true;
    root.clear(); geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); textures.forEach(texture => texture.dispose());
  } };
}
