import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import * as T from '../assets/vendor/three.module.js';
import { createProjection, clipRing, area, clipLine, interiorPoint, pointInRing, buildingInfo, prepareScene, createRouteSampler, clampCameraTarget } from '../game-map-model.mjs';
import { makeShape, GeometryBatch, buildDistrict, gabledRoofGeometry, buildingGeometry, canopyGeometry, streetFacades, roofFixtureFits } from '../game-map-scene.mjs';
import { ATLAS, facadeWallUV, facadeComposition, createToonRamp, createCitySky } from '../game-map-art.mjs';
import { planFrustum, groundScale, bearing, roadLabelAnchors } from '../game-map-navigation.mjs';
import { streetTopologySignature } from '../game-map-streets.mjs';
import clipping from '../assets/vendor/polyclip-ts.mjs';

const bbox = [104.07, 30.65, 104.08, 30.66], projection = createProjection(bbox);
const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
test('geographic projection keeps north forward, preserves real meter distances and round-trips POIs', () => {
  assert.deepEqual(projection.project(projection.center), [0, -0]);
  assert.ok(projection.project([104.075, 30.66])[1] < 0);
  const point = [104.07719, 30.6581]; projection.unproject(projection.project(point)).forEach((v, i) => near(v, point[i]));
  near(projection.project([projection.center[0], projection.center[1] + .001])[1], -111.319490793, 1e-5);
  assert.throws(() => createProjection([1, 2, 1, 3]), /范围/);
});
test('polygons and roads are clipped to requested bounds even when raw OSM ways extend outside', () => {
  const clipped = clipRing([[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]], [-10, -10, 10, 10]);
  near(Math.abs(area(clipped)), 400);
  assert.ok(clipped.every(([x, z]) => Math.abs(x) <= 10 && Math.abs(z) <= 10));
  assert.deepEqual(clipRing([[30, 30], [40, 30], [40, 40]], [-10, -10, 10, 10]), []);
  assert.deepEqual(clipLine([-20, 4], [20, 4], [-10, -10, 10, 10]), [[-10, 4], [10, 4]]);
  assert.equal(clipLine([11, -20], [11, 20], [-10, -10, 10, 10]), null);
});
test('building anchors stay inside concave footprints and out of courtyards', () => {
  const outer = [[0, 0], [20, 0], [20, 20], [0, 20]], hole = [[5, 5], [15, 5], [15, 15], [5, 15]];
  const anchor = interiorPoint([outer, hole]); assert.ok(pointInRing(anchor, outer)); assert.ok(!pointInRing(anchor, hole));
  const concave = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
  assert.ok(pointInRing(interiorPoint([concave]), concave));
});
test('building facts distinguish missing, supplied and estimated heights, independently of display compression', () => {
  const missing = buildingInfo({}); assert.equal(missing.name, '未命名建筑'); assert.equal(missing.levels, null); assert.equal(missing.heightSource, 'visual_estimate');
  const source = buildingInfo({ height_m: 248, height_source: 'osm_height', tags: { 'source:height': 'estimated', 'building:levels': '46' } });
  assert.equal(source.height, 248); assert.equal(source.estimated, true); assert.equal(source.levels, 46); assert.ok(source.displayHeight < source.height);
  const levels = buildingInfo({ height_m: null, tags: { 'building:levels': '5' } }); assert.equal(levels.height, 15); assert.equal(levels.heightSource, 'estimated_from_levels_3m');
});
test('3D extrusion preserves courtyards and correctly maps roof height / north direction', () => {
  const rings = [[[0, 0], [20, 0], [20, 20], [0, 20]], [[5, 5], [5, 15], [15, 15], [15, 5]]];
  const g = new T.ExtrudeGeometry(makeShape(rings), { depth: 12, bevelEnabled: false }); g.rotateX(-Math.PI / 2);
  const mesh = new T.Mesh(g, new T.MeshBasicMaterial({ side: T.DoubleSide })); mesh.updateMatrixWorld();
  const ray = new T.Raycaster(new T.Vector3(10, 40, 10), new T.Vector3(0, -1, 0));
  assert.equal(ray.intersectObject(mesh).length, 0, 'open courtyard must not be filled');
  ray.ray.origin.set(2, 40, 2); near(ray.intersectObject(mesh)[0].point.y, 12);
  g.computeBoundingBox(); near(g.boundingBox.max.z, 20); near(g.boundingBox.max.y, 12);
});
test('batching retains per-building picking through merged roof/wall triangles', () => {
  const batch = new GeometryBatch(), group = new T.Group(), mat = new T.MeshBasicMaterial();
  const a = { id: 'A' }, b = { id: 'B' };
  batch.add(new T.BoxGeometry(10, 10, 10).translate(-20, 5, 0), mat, a);
  batch.add(new T.BoxGeometry(10, 20, 10).translate(20, 10, 0), mat, b);
  const [mesh] = batch.finish(group); group.updateMatrixWorld(true);
  assert.equal(group.children.length, 1, 'shared material should use one draw');
  for (const [x, owner] of [[-20, a], [20, b]]) {
    const hit = new T.Raycaster(new T.Vector3(x, 50, 0), new T.Vector3(0, -1, 0)).intersectObject(mesh)[0];
    assert.equal(mesh.userData.owners[hit.faceIndex], owner);
  }
});
test('route simulation follows source segments instead of shortcutting across blocks', () => {
  const sampler = createRouteSampler([[0, 0], [100, 0], [100, 100]]); near(sampler.length, 200);
  assert.deepEqual(sampler.at(150).position, [100, 50]); assert.deepEqual(sampler.at(-1).position, [0, 0]);
  assert.deepEqual(sampler.at(1000).position, [100, 100]);
  const target = { x: 999, z: -999 }, eye = { x: 1009, z: -989 };
  clampCameraTarget(target, eye, [-500, -500, 500, 500]);
  assert.deepEqual(target, { x: 495, z: -495 }); assert.deepEqual(eye, { x: 505, z: -485 });
});
test('scene validation rejects coordinate mixing and never accepts out-of-area places or routes', () => {
  const geo = { metadata: { coordinate_system: 'WGS84', requested_bbox_wgs84: bbox }, features: [] };
  const scene = prepareScene(geo, { hotspots: [{ name: 'outside', coordinateSystem: 'WGS84', coordinate: [0, 0] }, { name: 'wrong CRS', coordinateSystem: 'BD09LL', coordinate: projection.center }] }, { available: true, coordinateSystem: 'WGS84', coordinates: [projection.center, [0, 0]] });
  assert.equal(scene.places.length, 0); assert.equal(scene.route, null);
  assert.throws(() => prepareScene({ metadata: { coordinate_system: 'BD09LL' } }), /WGS84/);
});

test('same-name road and metro POIs retain independent source coordinates and IDs', () => {
  const point = (id, coordinate) => ({ type: 'Feature', id, properties: { kind: 'poi', uid: id, name: '春熙路', source_crs: 'BD09LL', source_coordinates: [104.0845, 30.66275] }, geometry: { type: 'Point', coordinates: coordinate } });
  const geo = { metadata: { coordinate_system: 'WGS84', requested_bbox_wgs84: bbox }, features: [point('road', [104.075, 30.655]), point('metro', [104.076, 30.656])] };
  const scene = prepareScene(geo, { hotspots: [{ id: 'road', name: 'spring', coordinateSystem: 'WGS84', coordinate: [104.077, 30.657] }] });
  assert.equal(scene.places.length, 2); assert.deepEqual(scene.places[0].coordinate, [104.075, 30.655]);
  assert.deepEqual(scene.places[0].sourceBD09, [104.0845, 30.66275]);
  assert.notDeepEqual(scene.places[0].position, scene.places[1].position);
});

test('north-up plan camera preserves footprints without roof parallax and has a metric scale at each zoom', () => {
  const f = planFrustum([-500, -500, 500, 500], 1.5), camera = new T.OrthographicCamera(f.left, f.right, f.top, f.bottom, .1, 4000);
  camera.position.set(0, 1500, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const ground = new T.Vector3(120, 0, -80).project(camera), roof = new T.Vector3(120, 95, -80).project(camera);
  near(ground.x, roof.x); near(ground.y, roof.y);
  for (const zoom of [1, 3, 12]) {
    camera.zoom = zoom; camera.updateProjectionMatrix();
    const scale = groundScale(camera, 1500, 1000);
    near(scale.meters / scale.pixels, (f.right - f.left) / zoom / 1500);
  }
  near(bearing({ x: 0, z: 10 }, { x: 0, z: 0 }), 0);
  near(bearing({ x: -10, z: 0 }, { x: 0, z: 0 }), 90);
  near(bearing({ x: 10, z: 0 }, { x: 0, z: 0 }), -90);
});

test('road labels use real named segments and remain on their road', () => {
  const result = roadLabelAnchors([{ name: '春熙路', segments: [[[0, 0], [100, 0]], [[0, 0], [20, 0]]] }, { name: '', segments: [[[0, 0], [500, 0]]] }]);
  assert.equal(result.length, 1); assert.deepEqual(result[0].position, [50, 0]); assert.equal(result[0].name, '春熙路');
});

test('cartoon gabled roofs keep the original footprint and open courtyards', () => {
  const rings = [[[0, 0], [20, 0], [20, 30], [0, 30]], [[6, 10], [14, 10], [14, 20], [6, 20]]];
  const g = gabledRoofGeometry({ rings, displayHeight: 12 }); g.computeBoundingBox();
  near(g.boundingBox.min.x, 0); near(g.boundingBox.max.x, 20); near(g.boundingBox.max.z, 30);
  assert.ok(g.boundingBox.max.y > 15);
  const mesh = new T.Mesh(g, new T.MeshBasicMaterial({ side: T.DoubleSide })); mesh.updateMatrixWorld();
  const ray = new T.Raycaster(new T.Vector3(10, 40, 15), new T.Vector3(0, -1, 0));
  assert.equal(ray.intersectObject(mesh).length, 0);
  ray.ray.origin.set(2, 40, 2); assert.ok(ray.intersectObject(mesh).length);
});
test('soft building edges preserve source data and open courtyards, with continuous shading normals', () => {
  const rings = [[[0, 0], [20, 0], [20, 30], [0, 30]], [[6, 10], [14, 10], [14, 20], [6, 20]]];
  const original = structuredClone(rings), g = buildingGeometry({ rings, displayHeight: 12, tags: {} });
  assert.deepEqual(rings, original); g.computeBoundingBox();
  assert.ok(g.boundingBox.min.x >= -.02 && g.boundingBox.max.x <= 20.02);
  const normals = g.getAttribute('normal');
  assert.ok(Array.from(normals.array).every(Number.isFinite));
  // Courtyard caps deliberately omit bevels: bevelOffset would close part of
  // the surveyed opening. Their outside corners still need smooth wall normals.
  assert.ok(Array.from({ length: normals.count }, (_, i) => i).some(i =>
    Math.abs(normals.getX(i)) > .1 && Math.abs(normals.getZ(i)) > .1 && Math.abs(normals.getY(i)) < .001),
  'courtyard outside corners must retain interpolated horizontal normals');
  const solid = buildingGeometry({ rings: [rings[0]], displayHeight: 12, tags: {} }), bevelNormals = solid.getAttribute('normal');
  assert.ok(Array.from({ length: bevelNormals.count }, (_, i) => Math.abs(bevelNormals.getY(i))).some(y => y > .1 && y < .9),
    'a solid parcel must retain actual bevels with interpolated vertical normals');
  const mesh = new T.Mesh(g, new T.MeshBasicMaterial({ side: T.DoubleSide })); mesh.updateMatrixWorld();
  assert.equal(new T.Raycaster(new T.Vector3(10, 40, 15), new T.Vector3(0, -1, 0)).intersectObject(mesh).length, 0);
  const canopy = canopyGeometry(), pos = canopy.getAttribute('position');
  assert.ok(new Set(Array.from({ length: pos.count }, (_, i) => pos.getX(i))).size > 6, 'canopies must have sampled curves rather than box corners');
  g.dispose(); solid.dispose(); canopy.dispose();
});

test('a full wall uses one atlas panel at any building size, rather than tiling windows by metres', () => {
  for (const scale of [1, 8]) {
    const b = { id: 'facade-test', name: '', use: '', tags: {}, displayHeight: 12 * scale,
      rings: [[[0, 0], [20 * scale, 0], [20 * scale, 30 * scale], [0, 30 * scale]]] };
    const uv = facadeWallUV(b, [[0, 0, 0], [20 * scale, 0, 0], [20 * scale, 0, b.displayHeight], [0, 0, b.displayHeight]]);
    near(Math.abs(uv[1][0] - uv[0][0]), (ATLAS.cell - ATLAS.gutter * 2) / ATLAS.size);
    near(Math.abs(uv[3][1] - uv[0][1]), (ATLAS.cell - ATLAS.gutter * 2) / ATLAS.size);
    assert.ok(uv.flat().every(v => v > 0 && v < 1));
    assert.equal(new Set(uv.map(([u]) => Math.floor(u * ATLAS.columns))).size, 1);
    assert.equal(new Set(uv.map(([, v]) => Math.floor(v * ATLAS.columns))).size, 1);
  }
  const coverages = [];
  for (let profile = 0; profile < 8; profile++) for (let palette = 0; palette < 8; palette++) {
    const design = facadeComposition(profile, palette), area = [...design.windows, ...design.bands].reduce((n, w) => n + w.w * w.h, 0);
    assert.ok(area < .24, `a facade needs substantial uninterrupted wall, profile ${profile}`); coverages.push(area);
    for (const w of design.windows) assert.ok(w.x > 0 && w.y > 0 && w.x + w.w < 1 && w.y + w.h < .82);
  }
  assert.ok(Math.max(...coverages) > Math.min(...coverages) * 2, 'quiet sides and glazed fronts should have different density');
  const ramp = createToonRamp().image.data;
  assert.ok(ramp[0] < ramp[255 * 4]);
  for (let i = 4; i < ramp.length; i += 4) assert.ok(ramp[i] >= ramp[i - 4]);
});

test('commercial details face nearby streets and roof fixtures cannot fill courtyards or spill off a parcel', () => {
  const building = { rings: [[[0, 0], [40, 0], [40, 40], [0, 40]], [[15, 15], [25, 15], [25, 25], [15, 25]]] };
  const fronts = streetFacades(building, [{ segments: [[[-10, -8], [50, -8]]] }]);
  assert.equal(fronts.length, 1); assert.deepEqual(fronts[0].mid, [20, 0]);
  assert.equal(roofFixtureFits(building, [20, 20], 4, 4), false);
  assert.equal(roofFixtureFits(building, [8, 8], 4, 4), true);
  assert.equal(roofFixtureFits(building, [1, 8], 4, 4), false);
  assert.equal(roofFixtureFits(building, [20, 20], 28, 28), false, 'enclosed courtyard cannot be bridged');
});

test('district backdrop uses pale atmosphere with a warm horizon instead of an ocean-like blue lower hemisphere', () => {
  const ctx = { beginPath() {}, moveTo() {}, ellipse() {}, fill() {} }, previous = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  let sky;
  try { sky = createCitySky({ capabilities: { getMaxAnisotropy: () => 8 } }); } finally { globalThis.document = previous; }
  const dome = sky.getObjectByName('city-sky-dome'), { zenith, horizon, groundHaze } = dome.material.uniforms;
  const srgb = color => new T.Color(color).getRGB({}, T.SRGBColorSpace);
  for (const { value } of [zenith, horizon, groundHaze]) {
    const { r, g, b } = srgb(value);
    assert.ok(Math.min(r, g, b) > .65, 'background colors should stay pale');
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < .16, 'background should avoid saturated cyan');
  }
  const lower = srgb(groundHaze.value), edge = srgb(horizon.value);
  assert.ok(lower.r > lower.b && edge.r > edge.b, 'below the map edge should be warm neutral haze');
  assert.equal(dome.material.depthWrite, false, 'the sky must never occlude city geometry');
  assert.equal(dome.material.side, T.BackSide); assert.equal(ctx.filter, 'blur(8px)');
  sky.traverse(object => { object.geometry?.dispose(); object.material?.map?.dispose(); object.material?.dispose(); });
});
test('actual Chunxi snapshot builds finite 3D buffers, separate facade detail and working raycast', async t => {
  const base = new URL('../output/', import.meta.url);
  try { await access(new URL('scene.geojson', base)); } catch { t.skip('Download a real scene to run geographic integration'); return; }
  const geo = JSON.parse(await readFile(new URL('scene.geojson', base), 'utf8'));
  let route = null;
  try { route = JSON.parse(await readFile(new URL('game/route.preview.json', base), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = prepareScene(geo, undefined, route);
  let cachedStreets = null;
  try {
    const cache = JSON.parse(await readFile(new URL('game/street-topology.json', base), 'utf8'));
    if (cache.formatVersion === 1 && cache.sourceSignature === await streetTopologySignature(model)) cachedStreets = cache.topology;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const gradient = { addColorStop() {} }, ctx = { fillRect() {}, strokeRect() {}, fillText() {}, createLinearGradient() { return gradient; }, createRadialGradient() { return gradient; } };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  let district;
  try { district = buildDistrict(model, { capabilities: { getMaxAnisotropy: () => 8 } }, cachedStreets); } finally { globalThis.document = previous; }
  assert.ok(district.stats.buildings > 350); assert.equal(district.stats.trees, 0);
  let triangles = 0, instances = 0;
  district.root.traverse(object => {
    if (!object.geometry) return;
    const attr = object.geometry.getAttribute('position'); assert.ok(Array.from(attr.array).every(Number.isFinite));
    const index = object.geometry.index; if (object.isMesh) triangles += (index ? index.count : attr.count) / 3 * (object.count || 1);
    if (object.isInstancedMesh) instances += object.count;
  });
  assert.ok(instances > 0, 'near detail must be actual separate storefront / roof geometry');
  assert.ok(triangles < 1500000, 'rounded detailing must stay within the district geometry budget');
  assert.ok(district.pickMeshes.some(m => m.material.isMeshStandardMaterial && m.material.map?.wrapS === T.ClampToEdgeWrapping), 'city facades must use continuous lighting and composed, non-repeating panels');
  // Independently derive each emitted box's world footprint with Three.js,
  // rather than trusting the production clearance helper or centre samples.
  const measure = polygons => polygons.reduce((sum, rings) => sum + Math.abs(area(rings[0]))
    - rings.slice(1).reduce((holes, ring) => holes + Math.abs(area(ring)), 0), 0);
  const footprints = new Map(model.buildings.map(b => [b.id, clipping.union(b.rings)]));
  const bounds = polygons => {
    const points = polygons.flat(2);
    return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
      Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  };
  const sourceBounds = new Map([...footprints].map(([id, polygons]) => [id, bounds(polygons)]));
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  let checkedDetails = 0, supportedDetails = 0;
  for (const detail of district.detailAudit) {
    assert.ok(model.buildings.some(b => b.id === detail.buildingId));
    const [width, height, depth] = detail.size, rotation = new T.Matrix4().makeRotationY(detail.yaw || 0);
    const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => {
      const v = new T.Vector3(x * width / 2, 0, z * depth / 2).applyMatrix4(rotation);
      return [v.x + detail.position[0], v.z + detail.position[2]];
    });
    const polygon = [[ring]], bbox = bounds(polygon), bottom = detail.position[1] - height / 2, top = detail.position[1] + height / 2;
    for (const other of model.buildings) {
      if (other.id === detail.buildingId || top <= (other.displayBaseHeight || 0) + 1e-8 || bottom >= other.displayHeight - 1e-8
        || !overlaps(bbox, sourceBounds.get(other.id))) continue;
      const intrusion = measure(clipping.intersection(polygon, footprints.get(other.id)));
      assert.ok(intrusion <= 1e-8, `${detail.buildingId}/${detail.kind} penetrates ${other.id} by ${intrusion}m²`);
    }
    if (['parapet', 'roofCore'].includes(detail.kind)) {
      const unsupported = measure(clipping.difference(polygon, footprints.get(detail.buildingId)));
      assert.ok(unsupported <= 1e-8, `${detail.buildingId}/${detail.kind} floats outside its roof by ${unsupported}m²`);
      supportedDetails++;
    }
    checkedDetails++;
  }
  assert.ok(checkedDetails > 1000, 'audit must cover every accepted facade and rooftop detail');
  assert.ok(supportedDetails > 100, 'audit must exercise roof support independently');
  district.root.updateMatrixWorld(true);
  const b = model.buildings.find(b => /IFS国际金融中心/.test(b.name)); assert.ok(b);
  const ray = new T.Raycaster(new T.Vector3(b.center[0], 400, b.center[1]), new T.Vector3(0, -1, 0));
  const hit = ray.intersectObjects(district.pickMeshes)[0]; assert.ok(hit);
  const owner = hit.object.userData.building || hit.object.userData.owners[hit.faceIndex]; assert.ok(owner);
  district.setPlan(true);
  const flatHit = ray.intersectObjects(district.planPickMeshes)[0]; assert.ok(flatHit);
  assert.ok(flatHit.point.y < 1, 'plan picking must use ground footprints, not the invisible roofs');
  assert.ok(district.planPickMeshes.every(m => m.parent.visible));
  assert.ok(district.pickMeshes.every(m => !m.parent.visible));
  district.setPlan(false);
  t.diagnostic(JSON.stringify({ ...district.stats, triangles, detailInstances: instances }));
});
