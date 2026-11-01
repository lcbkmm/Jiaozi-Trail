import * as T from './assets/vendor/three.module.js';
import { pointInRing } from './game-map-model.mjs';
import { buildStreetTopology } from './game-map-streets.mjs';
import { buildBuildingTopology, createBuildingClearance } from './game-map-buildings.mjs';
import { createDistrictSurroundings } from './game-map-surroundings.mjs';
import { createMapAvatar } from './game-map-avatar.mjs';
import { CITY_PALETTE, buildingPalette, facadePanel, facadeComposition, facadeWallUV, createFacadeAtlas, createWindowMap, paintedWash } from './game-map-art.mjs';
import { roundedBoxGeometry } from './game-map-rounded.mjs';

const v3 = (p, y = 0) => new T.Vector3(p[0], y, p[1]);
const hash = s => [...String(s)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);
export function makeShape(rings) {
  // Shape XY is rotated -90 degrees around X, so its Y is geographic north.
  const convert = r => r.map(([x, z]) => new T.Vector2(x, -z));
  const shape = new T.Shape(convert(rings[0]));
  for (const ring of rings.slice(1)) shape.holes.push(new T.Path(convert(ring)));
  return shape;
}
function softShape(rings, radius) {
  const path = (ring, hole = false) => {
    const p = hole ? new T.Path() : new T.Shape();
    const points = ring.map(([x, z]) => new T.Vector2(x, -z));
    const winding = Math.sign(points.reduce((sum, a, i) => sum + a.cross(points[(i + 1) % points.length]), 0));
    const distanceToEdge = (point, a, b) => {
      const edge = b.clone().sub(a), square = edge.lengthSq();
      const t = square ? Math.max(0, Math.min(1, point.clone().sub(a).dot(edge) / square)) : 0;
      return point.distanceTo(a.clone().addScaledVector(edge, t));
    };
    for (let i = 0; i < points.length; i++) {
      const b = points[i], previous = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length];
      const convex = b.clone().sub(previous).cross(next.clone().sub(b)) * winding > 1e-8;
      // A convex outer corner can only remove solid area. Concave corners and
      // all courtyard corners stay exact; rounding those would fill open space.
      let r = !hole && convex ? Math.min(radius, b.distanceTo(previous) * .18, b.distanceTo(next) * .18) : 0;
      if (r > 0) for (let j = 0; j < points.length; j++) {
        if (j === i || (j + 1) % points.length === i) continue;
        r = Math.min(r, distanceToEdge(b, points[j], points[(j + 1) % points.length]) * .25);
      }
      const a = b.clone().add(previous.clone().sub(b).normalize().multiplyScalar(r));
      const c = b.clone().add(next.clone().sub(b).normalize().multiplyScalar(r));
      if (!i) p.moveTo(a.x, a.y); else p.lineTo(a.x, a.y);
      if (r > 1e-8) p.quadraticCurveTo(b.x, b.y, c.x, c.y);
    }
    p.closePath(); return p;
  };
  const shape = path(rings[0]); shape.holes = rings.slice(1).map(r => path(r, true)); return shape;
}
function smoothWallNormals(geometry) {
  // Weld shading normals, not UVs or source positions. Caps keep their flat normals.
  const pos = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), sums = new Map();
  const group = geometry.groups.find(g => g.materialIndex === 1); if (!group) return;
  const key = i => `${Math.round(pos.getX(i) * 10000)},${Math.round(pos.getY(i) * 10000)},${Math.round(pos.getZ(i) * 10000)}`;
  for (let i = group.start; i < group.start + group.count; i++) {
    const k = key(i), n = sums.get(k) || new T.Vector3(); n.add(new T.Vector3().fromBufferAttribute(normals, i)); sums.set(k, n);
  }
  for (const n of sums.values()) n.normalize();
  for (let i = group.start; i < group.start + group.count; i++) { const n = sums.get(key(i)); normals.setXYZ(i, n.x, n.y, n.z); }
}
export function buildingGeometry(building) {
  const traditional = building.tags['roof:shape'] === 'gabled';
  const base = Math.max(0, building.displayBaseHeight || 0), span = Math.max(.01, building.displayHeight - base);
  const wallStyle = base ? { ...building, displayHeight: span } : building;
  // ExtrudeGeometry applies bevelOffset to holes as well, shrinking their cap
  // openings into the courtyard. Keep those openings exact with an unbeveled cap.
  const bevel = !traditional && building.rings.length === 1;
  // Sub-meter corner rounding is a visual treatment; plan view retains the exact footprint.
  const shape = traditional ? makeShape(building.rings) : softShape(building.rings, .55);
  const extrude = bevelEnabled => new T.ExtrudeGeometry(shape, { depth: span, steps: 1, curveSegments: 4,
    bevelEnabled, bevelThickness: .18, bevelSize: .14, bevelOffset: -.14, bevelSegments: 3,
    UVGenerator: {
      generateTopUV(g, vertices, a, b, c) { return [a, b, c].map(i => new T.Vector2(vertices[i * 3] / 32, vertices[i * 3 + 1] / 32)); },
      generateSideWallUV(g, vertices, a, b, c, d) {
        return facadeWallUV(wallStyle, [a, b, c, d].map(i => [vertices[i * 3], -vertices[i * 3 + 1], vertices[i * 3 + 2]]))
          .map(p => new T.Vector2(...p));
      }
    } });
  let geometry = extrude(bevel);
  if (bevel) {
    // Three.js's bevel miters can invert at very narrow corners, even in a
    // convex parcel. Detect those rare escapes before they enter a street or
    // neighboring building, and retain the rounded outline without a bevel.
    const position = geometry.getAttribute('position'), checked = new Set(), ring = building.rings[0];
    for (let i = 0; i < position.count; i++) {
      const point = [position.getX(i), -position.getY(i)], key = `${point[0]},${point[1]}`;
      if (checked.has(key)) continue;
      checked.add(key);
      if (pointInRing(point, ring)) continue;
      const onBoundary = ring.some((a, j) => {
        const b = ring[(j + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1], square = dx * dx + dz * dz;
        const t = square ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / square)) : 0;
        return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz) <= .001;
      });
      if (!onBoundary) { geometry.dispose(); geometry = extrude(false); break; }
    }
  }
  if (!traditional) smoothWallNormals(geometry);
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, .24 + base, 0); return geometry;
}
export function canopyGeometry() {
  const shape = new T.Shape(), r = .16;
  shape.moveTo(-.5 + r, -.5); shape.lineTo(.5 - r, -.5); shape.quadraticCurveTo(.5, -.5, .5, -.5 + r);
  shape.lineTo(.5, .5 - r); shape.quadraticCurveTo(.5, .5, .5 - r, .5); shape.lineTo(-.5 + r, .5);
  shape.quadraticCurveTo(-.5, .5, -.5, .5 - r); shape.lineTo(-.5, -.5 + r); shape.quadraticCurveTo(-.5, -.5, -.5 + r, -.5);
  const geometry = new T.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 4 });
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, -.5, 0); return geometry;
}
export function windowPaneGeometry() {
  // The outline, not just the painted glass, has curved corners. UVs still
  // cover one whole pane, so the close-view reflection never tiles.
  const shape = new T.Shape(), r = .045;
  shape.moveTo(-.5 + r, -.5); shape.lineTo(.5 - r, -.5);
  shape.quadraticCurveTo(.5, -.5, .5, -.5 + r); shape.lineTo(.5, .5 - r);
  shape.quadraticCurveTo(.5, .5, .5 - r, .5); shape.lineTo(-.5 + r, .5);
  shape.quadraticCurveTo(-.5, .5, -.5, .5 - r); shape.lineTo(-.5, -.5 + r);
  shape.quadraticCurveTo(-.5, -.5, -.5 + r, -.5);
  const geometry = new T.ShapeGeometry(shape, 3), uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + .5, uv.getY(i) + .5);
  geometry.name = '圆角窗玻璃'; return geometry;
}
function texture(canvas, renderer) {
  const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.minFilter = T.LinearMipmapLinearFilter; tex.magFilter = T.LinearFilter;
  return tex;
}
function storefrontTexture(renderer) {
  const canvas = document.createElement('canvas'), emission = document.createElement('canvas');
  canvas.width = emission.width = 1024; canvas.height = emission.height = 512;
  const ctx = canvas.getContext('2d'), glow = emission.getContext('2d');
  const glass = ctx.createLinearGradient(0, 0, 150, 512);
  glass.addColorStop(0, '#91c4d0'); glass.addColorStop(.2, '#d2e0ce'); glass.addColorStop(.43, '#ffe4b3'); glass.addColorStop(1, '#c08b57');
  ctx.fillStyle = glass; ctx.fillRect(0, 0, 1024, 512);
  // Warm shop interiors, with distant silhouettes softened into the painted glass.
  for (let i = 0; i < 8; i++) {
    const x = i * 137, h = 40 + hash(i) % 95;
    const interior = ctx.createLinearGradient(0, 512 - h, 0, 512); interior.addColorStop(0, '#6b7f7900'); interior.addColorStop(1, '#745a3a45');
    ctx.fillStyle = interior; ctx.fillRect(x, 512 - h, 80, h);
  }
  glow.fillStyle = '#71522a'; glow.fillRect(0, 0, 1024, 512);
  for (let x = 0; x <= 1024; x += 512) {
    ctx.fillStyle = '#6a8f9940'; ctx.fillRect(x, 0, 6, 512);
    ctx.fillStyle = '#f7fcf0b0'; ctx.fillRect(x + 7, 0, 2, 512);
    glow.fillStyle = '#000000'; glow.fillRect(x, 0, 8, 512);
  }
  return { map: texture(canvas, renderer), emissiveMap: texture(emission, renderer) };
}
function roofTexture(renderer, color, tiled = false) {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1024, 1024);
  paintedWash(ctx, color);
  // Modern roofs are quiet planes; tiles are reserved for actual pitched roofs.
  for (let row = 0; row < (tiled ? 16 : 0); row++) {
    const y = row * 64; ctx.fillStyle = '#233f4824'; ctx.fillRect(0, y, 1024, 2);
    if (tiled) { ctx.fillStyle = '#b7d7bf40'; ctx.fillRect(0, y + 5, 1024, 2);
      for (let col = -1; col < 16; col++) { const x = col * 64 + row % 2 * 32; ctx.fillStyle = '#0e2b4330'; ctx.fillRect(x, y, 2, 32); } }
  }
  const tex = texture(c, renderer); tex.wrapS = tex.wrapT = T.RepeatWrapping; return tex;
}
function pavingTexture(renderer) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const c = canvas.getContext('2d'); c.fillStyle = '#dcd6be'; c.fillRect(0, 0, 512, 512);
  paintedWash(c, 'pedestrian', 0, 0, 512);
  const tex = texture(canvas, renderer); tex.wrapS = tex.wrapT = T.RepeatWrapping; return tex;
}
// Batch all static triangles by shared material; the triangle table retains building picking.
export class GeometryBatch {
  constructor() { this.entries = new Map(); }
  add(geometry, materials, owner = null) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = g.getAttribute('position'), normal = g.getAttribute('normal'), uv = g.getAttribute('uv');
    for (const group of g.groups.length ? g.groups : [{ start: 0, count: position.count, materialIndex: 0 }]) {
      const mat = Array.isArray(materials) ? materials[group.materialIndex] : materials;
      if (!this.entries.has(mat)) this.entries.set(mat, { positions: [], normals: [], uvs: [], owners: [] });
      const dst = this.entries.get(mat);
      for (let i = group.start; i < group.start + group.count; i++) {
        dst.positions.push(position.getX(i), position.getY(i), position.getZ(i));
        dst.normals.push(normal?.getX(i) || 0, normal?.getY(i) || 0, normal?.getZ(i) || 0);
        dst.uvs.push(uv?.getX(i) || 0, uv?.getY(i) || 0);
        if ((i - group.start) % 3 === 0) dst.owners.push(owner);
      }
    }
    if (g !== geometry) g.dispose(); geometry.dispose();
  }
  finish(parent, { shadows = true } = {}) {
    const meshes = [];
    for (const [material, data] of this.entries) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(data.positions, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(data.normals, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(data.uvs, 2));
      const mesh = new T.Mesh(g, material); mesh.castShadow = shadows; mesh.receiveShadow = true;
      mesh.userData.owners = data.owners; parent.add(mesh); meshes.push(mesh);
    }
    this.entries.clear(); return meshes;
  }
}
function flatShape(rings, y, material, batch) {
  const geometry = new T.ShapeGeometry(makeShape(rings)); geometry.rotateX(-Math.PI / 2); geometry.translate(0, y, 0);
  batch.add(geometry, material);
}
export function gabledRoofGeometry(building) {
  // Split the footprint's triangles at the ridge. No rectangular proxy roof:
  // even concave edges and courtyards keep the exact source footprint.
  const ring = building.rings[0]; let longest = 0, u = [1, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > longest) { longest = length; u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]; }
  }
  const v = [-u[1], u[0]], cross = p => p[0] * v[0] + p[1] * v[1];
  const values = ring.map(cross), min = Math.min(...values), max = Math.max(...values), center = (min + max) / 2;
  const rise = Math.min(4.2, (max - min) * .24), half = (max - min) / 2 || 1;
  const shape = new T.ShapeGeometry(makeShape(building.rings)), source = shape.index ? shape.toNonIndexed() : shape;
  const input = source.getAttribute('position'), positions = [], uvs = [];
  for (let i = 0; i < input.count; i += 3) {
    const triangle = [0, 1, 2].map(j => [input.getX(i + j), -input.getY(i + j)]);
    for (const sign of [-1, 1]) {
      const polygon = [];
      for (let j = 0; j < 3; j++) {
        const a = triangle[j], b = triangle[(j + 1) % 3], da = (cross(a) - center) * sign, db = (cross(b) - center) * sign;
        if (da >= 0) polygon.push(a);
        if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); polygon.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      for (let j = 1; j < polygon.length - 1; j++) for (const p of [polygon[0], polygon[j], polygon[j + 1]]) {
        positions.push(p[0], building.displayHeight + .27 + rise * Math.max(0, 1 - Math.abs(cross(p) - center) / half), p[1]);
        uvs.push((p[0] * u[0] + p[1] * u[1]) / 12, cross(p) / 12);
      }
    }
  }
  if (source !== shape) source.dispose(); shape.dispose();
  const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2)); geometry.computeVertexNormals(); return geometry;
}

export function streetFacades(building, roads) {
  const edges = [], ring = building.rings[0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    if (length < 7) continue;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; let normal = [-dz / length, dx / length];
    if (pointInRing([mid[0] + normal[0] * .15, mid[1] + normal[1] * .15], ring)) normal = normal.map(v => -v);
    let nearest = Infinity;
    for (const road of roads) for (const [p, q] of road.segments) {
      const vx = q[0] - p[0], vz = q[1] - p[1], square = vx * vx + vz * vz; if (!square) continue;
      const t = Math.max(0, Math.min(1, ((mid[0] - p[0]) * vx + (mid[1] - p[1]) * vz) / square));
      const direction = [p[0] + vx * t - mid[0], p[1] + vz * t - mid[1]];
      if (direction[0] * normal[0] + direction[1] * normal[1] > 0) nearest = Math.min(nearest, Math.hypot(...direction));
    }
    edges.push({ a, b, mid, normal, length, yaw: -Math.atan2(dz, dx), nearest });
  }
  return edges.filter(e => e.nearest < 38).sort((a, b) => a.nearest - b.nearest || b.length - a.length).slice(0, 2);
}

export function roofFixtureFits(building, position, width, depth) {
  // Check the complete perimeter; courtyard/concave parcels cannot acquire
  // floating rooftop fixtures merely because their centre lies in the polygon.
  for (let side = 0; side < 4; side++) for (let i = 0; i <= 12; i++) {
    const t = i / 12, x = position[0] + (side % 2 ? (side === 1 ? .5 : -.5) : t - .5) * width;
    const z = position[1] + (side % 2 ? t - .5 : side === 0 ? -.5 : .5) * depth;
    if (!pointInRing([x, z], building.rings[0]) || building.rings.slice(1).some(r => pointInRing([x, z], r))) return false;
  }
  // A small enclosed courtyard must not be entirely covered by the rectangle.
  return !building.rings.slice(1).some(r => r.some(p => Math.abs(p[0] - position[0]) < width / 2 && Math.abs(p[1] - position[1]) < depth / 2));
}

// Joined buildings use their exposed union surfaces. Internal walls and
// coplanar duplicate roofs must be removed in geometry, for every camera angle.
export function exposedBuildingGeometry(building, topology) {
  const positions = [], normals = [], uvs = [], groups = [];
  function cap(rings, y, underside = false) {
    const shape = new T.ShapeGeometry(makeShape(rings));
    const g = shape.index ? shape.toNonIndexed() : shape, p = g.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) for (const j of underside ? [0, 2, 1] : [0, 1, 2]) {
      const x = p.getX(i + j), z = -p.getY(i + j);
      positions.push(x, y, z); normals.push(0, underside ? -1 : 1, 0); uvs.push(x / 32, -z / 32);
    }
    if (g !== shape) g.dispose(); shape.dispose();
  }
  for (const rings of topology.roofs) cap(rings, topology.top + .24);
  if (topology.bottom > 0) cap(building.rings, topology.bottom + .24, true);
  groups.push({ start: 0, count: positions.length / 3, materialIndex: 0 });
  const wallStart = positions.length / 3;
  const wallStyle = { ...building, displayHeight: topology.top - topology.bottom };
  for (const wall of topology.walls) {
    const { a, b, normal, bottom, top } = wall;
    const corners = [[a[0], a[1], bottom], [b[0], b[1], bottom], [b[0], b[1], top], [a[0], a[1], top]];
    const uv = facadeWallUV(wallStyle, corners.map(([x, z, y]) => [x, z, y - topology.bottom]));
    const front = -(b[1] - a[1]) * normal[0] + (b[0] - a[0]) * normal[1] > 0;
    for (const i of front ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      positions.push(corners[i][0], corners[i][2] + .24, corners[i][1]);
      normals.push(normal[0], 0, normal[1]); uvs.push(...uv[i]);
    }
  }
  groups.push({ start: wallStart, count: positions.length / 3 - wallStart, materialIndex: 1 });
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  for (const group of groups) if (group.count) geometry.addGroup(group.start, group.count, group.materialIndex);
  return geometry;
}

function topologyIsUnchanged(building, topology) {
  const count = building.rings.reduce((sum, ring) => sum + ring.length, 0);
  return topology.walls.length === count && topology.walls.every(w => w.bottom === topology.bottom && w.top === topology.top
    && Math.hypot(w.a[0] - w.sourceA[0], w.a[1] - w.sourceA[1], w.b[0] - w.sourceB[0], w.b[1] - w.sourceB[1]) < 1e-7);
}

export function buildDistrict(model, renderer, precomputedStreets = null) {
  const root = new T.Group(), batch = new GeometryBatch(), roadsBatch = new GeometryBatch(), roofBatch = new GeometryBatch();
  const city = new T.Group(), plan = new T.Group(), planBatch = new GeometryBatch();
  root.add(city, plan); plan.visible = false;
  const footprintMat = new T.MeshBasicMaterial({ color: '#b4c0bd', side: T.DoubleSide });
  const namedFootprintMat = new T.MeshBasicMaterial({ color: '#b9a07b', side: T.DoubleSide });
  const outlinePoints = [];
  const facadeAtlas = createFacadeAtlas(renderer);
  // Continuous diffuse/specular response avoids the old hard cartoon bands.
  // Broad highlights keep the city illustrated without a glossy plastic finish.
  const surface = properties => new T.MeshStandardMaterial({ roughness: .78, metalness: 0, ...properties });
  const roofs = ['#d7d7c7', '#9cbfc5', '#e4d8be', '#b1c5ca'].map(color => surface({ map: roofTexture(renderer, color), side: T.DoubleSide }));
  const tiledRoof = surface({ map: roofTexture(renderer, '#557b86', true), side: T.DoubleSide });
  const facades = CITY_PALETTE.map(p => surface({ name: p.name, map: facadeAtlas }));
  const paving = surface({ map: pavingTexture(renderer), side: T.DoubleSide });
  const asphalt = surface({ color: '#82949a', side: T.DoubleSide });
  const curb = surface({ color: '#ede8d4', side: T.DoubleSide });
  const paint = surface({ color: '#fff9e5', side: T.DoubleSide });
  const green = surface({ color: '#719d75' });
  const water = surface({ color: '#479eaf' });
  const [west, north, east, south] = model.bounds;
  const base = new T.Mesh(new T.BoxGeometry(east - west, 12, south - north), surface({ color: '#d1c9af' }));
  base.position.y = -6; base.receiveShadow = true; root.add(base);
  const surroundings = createDistrictSurroundings(model.bounds); root.add(surroundings);
  const buildingTopology = buildBuildingTopology(model.buildings), clearance = createBuildingClearance(model.buildings);
  const detailAudit = [], detailStats = { accepted: 0, rejected: 0, joinedBuildings: 0 };
  const streets = precomputedStreets || buildStreetTopology(model);
  // Joined, disjoint faces replace overlapping segment ribbons and endpoint discs.
  // Ground heights no longer compensate for overlapping street topology.
  for (const [polygons, y, material] of [
    [streets.surfaces.water, .04, water], [streets.surfaces.green, .04, green], [streets.surfaces.paving, .04, paving],
    [streets.asphalt, .14, asphalt], [streets.pedestrian, .14, paving], [streets.curb, .14, curb],
    [streets.markings, .16, paint],
  ]) for (const rings of polygons) flatShape(rings, y, material, roadsBatch);
  roadsBatch.finish(root, { shadows: false });
  const detailChunks = new Map();
  const detailMaterials = {
    trim: surface({ color: '#e5dfcc' }),
    glass: surface({ ...storefrontTexture(renderer), roughness: .55, metalness: .06, emissive: '#ffe0aa', emissiveIntensity: .08, side: T.DoubleSide }),
    light: surface({ color: '#fff4d5', emissive: '#ffdc9d', emissiveIntensity: .18 }),
    dark: surface({ color: '#72888e' }),
    canopy: surface({ color: '#6eabb8' }),
    coral: surface({ color: '#d87560' }),
    vent: surface({ color: '#a9bfc2' }),
    upperGlass: surface({ map: createWindowMap(renderer), roughness: .46, metalness: .10, side: T.DoubleSide }),
    warmWindow: surface({ color: '#edd5a8', side: T.DoubleSide }),
    sill: surface({ color: '#eae5d5' }),
  };
  // Sub-decimetre rails are below the edge-detail budget: glazing supplies
  // their curved silhouette. Reserve bevel geometry for visible large forms.
  const railGeometry = new T.BoxGeometry(1, 1, 1), boxGeometry = roundedBoxGeometry(1, 1, 1, .10, 1), roundedCanopy = roundedBoxGeometry(1, 1, 1, .18, 2), windowGeometry = windowPaneGeometry(), ventGeometry = new T.CylinderGeometry(.5, .5, 1, 24), matrix = new T.Matrix4(), quat = new T.Quaternion();
  function detailBox(building, kind, pos, size, yaw = 0) {
    const plane = ['glass', 'upperGlass', 'warmWindow'].includes(kind);
    const volume = { position: [pos[0], pos[1] - .24, pos[2]], size: [size[0], size[1], plane ? .025 : size[2]], yaw };
    if (!clearance.fits(building, volume, { allowOwn: true })) { detailStats.rejected++; return false; }
    detailStats.accepted++; detailAudit.push({ buildingId: building.id, kind, ...volume });
    const key = `${Math.floor(building.center[0] / 100)},${Math.floor(building.center[1] / 100)}`;
    if (!detailChunks.has(key)) detailChunks.set(key, { center: [Math.floor(building.center[0] / 100) * 100 + 50, Math.floor(building.center[1] / 100) * 100 + 50], boxes: {}, group: new T.Group() });
    const chunk = detailChunks.get(key); (chunk.boxes[kind] ||= []).push({ pos, size, yaw });
    return true;
  }
  const signs = [], ink = [];
  for (const building of model.buildings) {
    const h = building.displayHeight, baseHeight = building.displayBaseHeight || 0, span = h - baseHeight;
    const seed = hash(building.id), traditional = building.tags['roof:shape'] === 'gabled', topology = buildingTopology.get(building.id);
    const variant = buildingPalette(building);
    // Plan view uses the source footprint at ground level, with no roof displacement.
    const flat = new T.ShapeGeometry(makeShape(building.rings)); flat.rotateX(-Math.PI / 2);
    flat.translate(0, .34 + h * .0001, 0);
    planBatch.add(flat, building.named ? namedFootprintMat : footprintMat, building);
    for (const ring of building.rings) for (let i = 0; i < ring.length; i++) outlinePoints.push(v3(ring[i], .36 + h * .0001), v3(ring[(i + 1) % ring.length], .36 + h * .0001));
    const joined = !topologyIsUnchanged(building, topology);
    if (joined) detailStats.joinedBuildings++;
    const geometry = joined ? exposedBuildingGeometry(building, topology) : buildingGeometry(building);
    batch.add(geometry, [roofs[seed % roofs.length], facades[variant]], building);
    if (traditional) {
      batch.add(gabledRoofGeometry(building), tiledRoof, building);
    }
    // Permanent parapets establish the silhouette even before near detail loads.
    let edge = 0;
    for (const [ringIndex, edgeRing] of building.rings.entries()) for (let i = 0; i < edgeRing.length; i++, edge++) {
      const a = edgeRing[i], b = edgeRing[(i + 1) % edgeRing.length], dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      if (length < 2) continue;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const yaw = -Math.atan2(dz, dx);
      let normal = [-dz / length, dx / length];
      if (pointInRing([mid[0] + normal[0] * .15, mid[1] + normal[1] * .15], building.rings[0])
        && !building.rings.slice(1).some(r => pointInRing([mid[0] + normal[0] * .15, mid[1] + normal[1] * .15], r))) normal = normal.map(v => -v);
      const exposed = topology.walls.filter(w => w.ringIndex === ringIndex && w.edgeIndex === i);
      if (!traditional) for (const wall of exposed.filter(w => Math.abs(w.top - h) < 1e-7)) {
        const wallLength = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
        if (wallLength < 1) continue;
        const center = [(wall.a[0] + wall.b[0]) / 2 - normal[0] * .18, h + .1, (wall.a[1] + wall.b[1]) / 2 - normal[1] * .18];
        const volume = { position: center, size: [wallLength - .5, .36, .24], yaw };
        if (!clearance.containsFootprint(building, volume) || !clearance.fits(building, volume, { allowOwn: true })) continue;
        const parapet = roundedBoxGeometry(...volume.size, .07, 1); parapet.rotateY(yaw); parapet.translate(center[0], center[1] + .24, center[2]);
        roofBatch.add(parapet, detailMaterials.trim);
        detailAudit.push({ buildingId: building.id, kind: 'parapet', ...volume });
      }
      if (length < 4 || !exposed.length) continue;
      const visible = (t, width, y, height) => exposed.some(w => {
        const along = p => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length;
        return t * length - width / 2 >= along(w.a) + .03 && t * length + width / 2 <= along(w.b) - .03
          && y - height / 2 >= w.bottom + .02 && y + height / 2 <= w.top - .02;
      });
      const panel = facadePanel(building, edge, length), design = facadeComposition(panel.profile, panel.palette);
      // Close views replace the atlas panes with sharp independent geometry,
      // retaining the same sparse composition and avoiding magnified pixels.
      for (const window of [...design.windows, ...design.bands]) {
        const t = window.x + window.w / 2, x = a[0] + dx * t + normal[0] * .08, z = a[1] + dz * t + normal[1] * .08;
        const y = baseHeight + (1 - window.y - window.h / 2) * span + .24, width = window.w * length, height = window.h * span;
        if (!visible(t, width, y - .24, height)) continue;
        detailBox(building, window.lit ? 'warmWindow' : 'upperGlass', [x, y, z], [width, height, 1], yaw);
        if (window.frame) detailBox(building, 'sill', [x + normal[0] * .06, y - height / 2, z + normal[1] * .06], [width + .06, .055, .22], yaw);
      }
    }
    // Storefronts only on road-facing outer walls, leaving side walls and
    // courtyards quiet. Two generous bays replace a shop on every nine metres.
    const signEdges = streetFacades(building, streets.groundRoads);
    if (baseHeight > .01) signEdges.length = 0;
    for (const { a, b, normal, length, yaw } of signEdges) {
      const dx = b[0] - a[0], dz = b[1] - a[1], shops = length > 28 ? 2 : 1;
      for (let j = 0; j < shops; j++) {
        const t = (j + .48) / shops, x = a[0] + dx * t + normal[0] * .18, z = a[1] + dz * t + normal[1] * .18;
        const w = Math.min(25, length / shops * .76), shopHeight = Math.min(3.8, span * .31);
        detailBox(building, 'glass', [x, shopHeight / 2 + .4, z], [w, shopHeight, 1], yaw);
        detailBox(building, 'trim', [x, shopHeight / 2 + .4, z], [.09, shopHeight + .1, .24], yaw);
        if ((seed + j) % 3 !== 0) {
          detailBox(building, seed % 2 ? 'canopy' : 'coral', [x + normal[0] * .62, shopHeight + .6, z + normal[1] * .62], [w + .15, .16, 1.55], yaw);
          detailBox(building, 'light', [x + normal[0] * 1.25, shopHeight + .51, z + normal[1] * 1.25], [w - .2, .055, .05], yaw);
        }
      }
    }
    const coreHeight = 1.5 + seed % 3 * .45;
    const coreVolume = { position: [building.center[0], h + coreHeight / 2 + .02, building.center[1]], size: [5.2, coreHeight, 3.5] };
    if (!traditional && seed % 4 !== 0 && clearance.containsFootprint(building, coreVolume) && clearance.fits(building, coreVolume, { allowOwn: true })) {
      // Modest setback roof access and cylindrical ventilation; no tiled boxes.
      const core = roundedBoxGeometry(...coreVolume.size, .28, 3);
      core.translate(coreVolume.position[0], coreVolume.position[1] + .24, coreVolume.position[2]); roofBatch.add(core, detailMaterials.trim);
      detailAudit.push({ buildingId: building.id, kind: 'roofCore', ...coreVolume });
      detailBox(building, 'vent', [building.center[0] + 1.5, h + coreHeight + .02 + .55 - .03, building.center[1]], [1.2, 1.1, 1.2]);
    }
    const longest = signEdges.sort((a, b) => b.length - a.length)[0];
    if (building.named && longest) signs.push({ building, edge: longest });
  }
  roofBatch.finish(city);
  city.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(ink), new T.LineBasicMaterial({ color: '#51656b', transparent: true, opacity: .23 })));
  const pickMeshes = batch.finish(city), planPickMeshes = planBatch.finish(plan, { shadows: false });
  plan.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(outlinePoints), new T.LineBasicMaterial({ color: '#546b70' })));
  for (const chunk of detailChunks.values()) {
    for (const [kind, boxes] of Object.entries(chunk.boxes)) {
      const plane = ['glass', 'upperGlass', 'warmWindow'].includes(kind);
      const mesh = new T.InstancedMesh(kind === 'canopy' || kind === 'coral' ? roundedCanopy : plane ? windowGeometry : kind === 'vent' ? ventGeometry : ['sill', 'light', 'trim'].includes(kind) ? railGeometry : boxGeometry, detailMaterials[kind], boxes.length);
      boxes.forEach((b, i) => {
        quat.setFromAxisAngle(new T.Vector3(0, 1, 0), b.yaw);
        matrix.compose(new T.Vector3(...b.pos), quat, new T.Vector3(...b.size)); mesh.setMatrixAt(i, matrix);
      });
      mesh.receiveShadow = true; chunk.group.add(mesh);
    }
    city.add(chunk.group); delete chunk.boxes;
  }
  for (const { building, edge } of signs) {
    const width = Math.min(edge.length * .7, Math.max(12, building.name.length * 1.8));
    const position = [edge.mid[0] + edge.normal[0] * .6, Math.min(building.displayHeight - 2, 8), edge.mid[1] + edge.normal[1] * .6];
    const signYaw = Math.atan2(edge.normal[0], edge.normal[1]);
    const volume = { position: [position[0], position[1] - .24, position[2]], size: [width, width * 192 / 1024, .025], yaw: signYaw };
    if (!clearance.fits(building, volume, { allowOwn: true })) { detailStats.rejected++; continue; }
    detailAudit.push({ buildingId: building.id, kind: 'sign', ...volume });
    const c = document.createElement('canvas'); c.width = 1024; c.height = 192;
    const ctx = c.getContext('2d'), sign = ctx.createLinearGradient(0, 0, 1024, 192);
    sign.addColorStop(0, /百货|广场/.test(building.name) ? '#c17366' : '#487f88'); sign.addColorStop(1, /百货|广场/.test(building.name) ? '#914f5c' : '#315d74');
    ctx.fillStyle = sign; ctx.fillRect(0, 0, 1024, 192);
    ctx.fillStyle = '#f9e8bc'; ctx.fillRect(26, 178, 972, 3);
    ctx.fillStyle = '#fff6df'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.min(96, 890 / Math.max(4, building.name.length))}px "Microsoft YaHei", sans-serif`;
    ctx.fillText(building.name, 512, 98, 930);
    const mesh = new T.Mesh(new T.PlaneGeometry(width, width * 192 / 1024), new T.MeshBasicMaterial({ map: texture(c, renderer), side: T.DoubleSide, toneMapped: false }));
    mesh.position.set(...position);
    mesh.rotation.y = signYaw; mesh.userData.building = building;
    city.add(mesh); pickMeshes.push(mesh);
  }
  const boundary = new T.LineLoop(new T.BufferGeometry().setFromPoints([[west, north], [east, north], [east, south], [west, south]].map(p => v3(p, .35))), new T.LineBasicMaterial({ color: '#f2dba9' })); root.add(boundary);
  const routeGroup = new T.Group(); root.add(routeGroup);
  if (model.route) {
    const routeBatch = new GeometryBatch(), routeMat = new T.MeshBasicMaterial({ color: '#f5c16a', side: T.DoubleSide });
    const innerMat = new T.MeshBasicMaterial({ color: '#fff3c3', side: T.DoubleSide });
    for (const rings of streets.route.band) flatShape(rings, .22, routeMat, routeBatch);
    for (const rings of streets.route.core) flatShape(rings, .22, innerMat, routeBatch);
    routeBatch.finish(routeGroup, { shadows: false });
    for (const p of [model.route.points[0], model.route.points.at(-1)]) {
      const ring = new T.Mesh(new T.RingGeometry(2.5, 3.3, 48), innerMat); ring.rotation.x = -Math.PI / 2; ring.position.copy(v3(p, .3)); routeGroup.add(ring);
    }
  }
  const avatar = createMapAvatar(); root.add(avatar);
  const selection = new T.Group(); root.add(selection);
  let planMode = false, selectedBuilding = null;
  function highlight(building) {
    selectedBuilding = building;
    for (const child of [...selection.children]) { child.geometry.dispose(); child.material.dispose(); selection.remove(child); }
    if (!building) return;
    const geo = new T.ExtrudeGeometry(makeShape(building.rings), { depth: planMode ? .01 : building.displayHeight + .5, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); geo.translate(0, planMode ? .5 : .3, 0);
    const mesh = new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: '#fff0a6', depthTest: true })); selection.add(mesh); geo.dispose();
  }
  const stats = { buildings: model.buildings.length, facadeMaterials: facades.length, facadeCompositions: 64, facadeTiling: false, shading: 'soft-standard', detailChunks: detailChunks.size, trees: 0, pickMeshes: pickMeshes.length, ...streets.stats, buildingDetails: detailStats };
  function updateDetails(camera) {
    let visible = 0;
    for (const chunk of detailChunks.values()) {
      chunk.group.visible = !planMode && Math.hypot(camera.position.x - chunk.center[0], camera.position.z - chunk.center[1]) < 380;
      if (chunk.group.visible) visible++;
    }
    return visible;
  }
  function setPlan(enabled) { planMode = enabled; city.visible = !enabled; surroundings.visible = !enabled; plan.visible = enabled; highlight(selectedBuilding); }
  return { root, pickMeshes, planPickMeshes, routeGroup, avatar, highlight, updateDetails, setPlan, stats, streets, buildingTopology, detailAudit };
}
