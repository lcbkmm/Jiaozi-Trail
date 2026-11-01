import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import clipping from '../assets/vendor/polyclip-ts.mjs';
import { buildStreetTopology, isGroundBuilding, isGroundRoad, roadWidth, streetTopologySignature } from '../game-map-streets.mjs';
import { area, pointInRing, prepareScene } from '../game-map-model.mjs';

const square = (west, north, east, south) => [[west, north], [east, north], [east, south], [west, south]];
const road = (kind, segments, tags = {}) => ({ road_class: kind, segments, tags });
const model = (roads = [], extra = {}) => ({ bounds: [-50, -50, 50, 50], roads, buildings: [], surfaces: [], ...extra });
const measure = polygons => polygons.reduce((total, rings) => total + Math.abs(area(rings[0])) - rings.slice(1).reduce((holes, ring) => holes + Math.abs(area(ring)), 0), 0);
const intersectArea = (a, b) => a.length && b.length ? measure(clipping.intersection(a, b)) : 0;
const contains = (polygons, point) => polygons.some(rings => pointInRing(point, rings[0]) && !rings.slice(1).some(hole => pointInRing(point, hole)));
const union = polygons => polygons.length ? clipping.union(...polygons) : [];

test('precomputed topology signature rejects changes to geometry, road levels and the route', async () => {
  const source = model([road('residential', [[[-20, 0], [20, 0]]])], {
    buildings: [{ rings: [square(10, 10, 20, 20)] }],
    surfaces: [{ rings: [square(-40, -40, 40, 40)], properties: { kind: 'landuse' } }],
    route: { points: [[-20, 0], [20, 0]] },
  });
  const signature = await streetTopologySignature(source);
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.notEqual(signature, 'e322059c6aa2d9d2a57bbd8743d6c9b56c54e162069748bd876084291009d28b',
    'the previous height-blind geometry algorithm must not reuse the same format-version-1 cache');
  assert.equal(await streetTopologySignature(structuredClone(source)), signature);
  for (const mutate of [
    m => { m.bounds[0]--; },
    m => { m.roads[0].tags.layer = '1'; },
    m => { m.roads[0].segments[0][0][0]--; },
    m => { m.buildings[0].rings[0][0][0]--; },
    m => { m.buildings[0].displayBaseHeight = 6; },
    m => { m.surfaces[0].properties.kind = 'water'; },
    m => { m.route.points[0][0]--; },
  ]) {
    const changed = structuredClone(source); mutate(changed);
    assert.notEqual(await streetTopologySignature(changed), signature, 'a changed geometry input cannot reuse a stale cache');
  }
});

test('ground roads and guidance remain continuous beneath explicitly suspended buildings', () => {
  const inputs = {
    surfaces: [{ rings: [square(-45, -40, 45, 40)], properties: { kind: 'landuse', tags: { landuse: 'retail' } } }],
    route: { points: [[-40, 0], [40, 0]] },
  };
  const source = model([road('primary', [[[-40, 0], [40, 0]]])], inputs);
  const baseline = buildStreetTopology(source);
  const suspended = { rings: [square(-15, -20, 15, 20)], displayBaseHeight: 6, displayHeight: 15,
    tags: { layer: '0', min_height: '6' } };
  const original = JSON.stringify(suspended);
  const streets = buildStreetTopology({ ...source, buildings: [suspended] });
  const layers = topology => ({ asphalt: topology.asphalt, pedestrian: topology.pedestrian,
    curb: topology.curb, markings: topology.markings, ...topology.surfaces,
    routeBand: topology.route.band, routeCore: topology.route.core });
  for (const [name, polygons] of Object.entries(layers(baseline))) {
    assert.ok(measure(clipping.xor(polygons, layers(streets)[name])) < 1e-5, `${name} was cut away underneath a suspended body`);
  }
  assert.ok(contains(streets.asphalt, [0, 0])); assert.ok(contains(streets.route.core, [0, 0]));
  assert.ok(intersectArea(streets.asphalt, [suspended.rings]) > 100, 'a ground street can occupy the same X/Z as an elevated building');
  assert.equal(JSON.stringify(suspended), original, 'height-aware masking must not modify source geometry');
  const grounded = { ...suspended, displayBaseHeight: 0, tags: { layer: '1' } };
  const solidStreets = buildStreetTopology({ ...source, buildings: [grounded] });
  assert.equal(contains(solidStreets.asphalt, [0, 0]), false, 'layer alone cannot make a solid building float');
  for (const building of [{}, { displayBaseHeight: 0 }, { displayBaseHeight: .14 }, { displayBaseHeight: .22 }]) {
    assert.equal(isGroundBuilding(building), true, 'a base reaching the ground surface must mask ground');
  }
  assert.equal(isGroundBuilding({ displayBaseHeight: .23 }), false);
  assert.equal(isGroundBuilding(suspended), false);
});

function assertDisjoint(layers, tolerance = 1e-5) {
  const entries = Object.entries(layers);
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const overlap = intersectArea(entries[i][1], entries[j][1]);
    assert.ok(overlap <= tolerance, `${entries[i][0]} / ${entries[j][0]} overlap ${overlap} m²`);
  }
  for (const [name, polygons] of entries) {
    assert.ok(Math.abs(measure(polygons) - measure(union(polygons))) <= tolerance, `${name} contains duplicated overlapping polygons`);
  }
}

test('crossroads and T junctions have continuous ground surfaces without a curb through their centres', () => {
  for (const vertical of [[[[0, -35], [0, 35]]], [[[0, -35], [0, 0]]]]) {
    const streets = buildStreetTopology(model([
      road('residential', [[[-35, 0], [35, 0]]]),
      road('residential', vertical),
    ]));
    for (const point of [[0, 0], [-6, 0], [6, 0], [0, -6], [-2, -2], [2, -2]]) {
      assert.ok(contains(streets.asphalt, point), `junction must remain connected at ${point}`);
      assert.ok(!contains(streets.curb, point), `curb cannot run across junction at ${point}`);
    }
    assertDisjoint({ asphalt: streets.asphalt, pedestrian: streets.pedestrian, curb: streets.curb });
  }
});

test('sharp turns and duplicate reversed segments are joined once with no change in road coverage', () => {
  const segments = [[[-35, 0], [0, 0]], [[0, 0], [-12, -28]], [[-12, -28], [-3, -33]]];
  const baseline = buildStreetTopology(model([road('residential', segments)]));
  const repeated = buildStreetTopology(model([
    road('residential', segments),
    road('residential', segments.map(([a, b]) => [b, a])),
  ]));
  for (const name of ['asphalt', 'curb']) {
    assert.ok(measure(clipping.xor(baseline[name], repeated[name])) < 1e-5, `${name} changes when source segments are duplicated`);
  }
  for (const point of [[-.2, -.1], [-12, -28], [-11, -27]]) assert.ok(contains(repeated.asphalt, point));
  assertDisjoint({ asphalt: repeated.asphalt, curb: repeated.curb });
});

test('motor and pedestrian crossings resolve to distinct material regions', () => {
  const streets = buildStreetTopology(model([
    road('primary', [[[-35, 0], [35, 0]]]),
    road('pedestrian', [[[0, -35], [0, 35]]]),
  ]));
  assert.ok(contains(streets.asphalt, [0, 0]));
  assert.ok(!contains(streets.pedestrian, [0, 0]));
  assert.ok(contains(streets.pedestrian, [0, 25]));
  assert.ok(!contains(streets.curb, [0, 12]), 'road junction has no transverse curb');
  assertDisjoint({ asphalt: streets.asphalt, pedestrian: streets.pedestrian, curb: streets.curb });
  assert.ok(streets.markings.length, 'major road keeps lane paint');
  assert.ok(measure(clipping.difference(streets.markings, streets.asphalt)) < 1e-5, 'paint cannot extend beyond asphalt');
});

test('road buffers are clipped to district bounds and buildings while preserving open courtyards', () => {
  const building = { rings: [square(-15, -15, 15, 15), square(-7, -7, 7, 7)] };
  const bounds = [-40, -30, 40, 30];
  const streets = buildStreetTopology(model([
    road('residential', [[[-55, 0], [55, 0]]]),
    road('footway', [[[-55, 28], [55, 28]]]),
  ], { bounds, buildings: [building] }));
  const parcel = [building.rings];
  for (const polygons of [streets.asphalt, streets.pedestrian, streets.curb, streets.markings]) {
    assert.ok(intersectArea(polygons, parcel) < 1e-5, 'street geometry enters a solid building');
    for (const p of polygons.flat(2)) {
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
      assert.ok(p[0] >= bounds[0] - 1e-6 && p[0] <= bounds[2] + 1e-6 && p[1] >= bounds[1] - 1e-6 && p[1] <= bounds[3] + 1e-6, `buffer exceeds district: ${p}`);
    }
  }
  assert.ok(contains(streets.asphalt, [0, 0]), 'a courtyard must not be filled by the building mask');
  assert.ok(!contains(streets.asphalt, [10, 0]), 'solid wall must mask the road');
  assert.ok(contains(streets.asphalt, [25, 0]), 'mask must not erase valid neighbouring road');
});

test('non-ground roads cannot be flattened into the ground street network', () => {
  const tags = [{ layer: '-1' }, { layer: '1' }, { tunnel: 'yes' }, { tunnel: 'building_passage' }, { bridge: 'yes' }, { location: 'roof' }, { location: 'underground' }, { indoor: 'yes' }, { level: '2' }];
  for (const value of tags) assert.equal(isGroundRoad(road('service', [], value)), false, JSON.stringify(value));
  for (const value of [{}, { layer: '0' }, { bridge: 'no', tunnel: 'no', indoor: 'no' }]) assert.equal(isGroundRoad(road('service', [], value)), true, JSON.stringify(value));
  const source = tags.map((value, i) => road('service', [[[i * 3 - 15, -30], [i * 3 - 15, 30]]], value));
  const streets = buildStreetTopology(model(source));
  assert.equal(streets.groundRoads.length, 0);
  assert.equal(measure(streets.asphalt) + measure(streets.pedestrian) + measure(streets.curb), 0);
  assert.ok(roadWidth(road('primary', [])) > roadWidth(road('footway', [])));
});

test('ground landcover, road materials and route core are partitioned instead of coplanar overlays', () => {
  const building = { rings: [square(20, -12, 33, 12)] };
  const surface = (kind, ring, tags = {}) => ({ rings: [ring], properties: { kind, tags } });
  const streets = buildStreetTopology(model([
    road('residential', [[[-45, 0], [45, 0]]]),
  ], {
    buildings: [building],
    surfaces: [
      surface('water', square(-25, -25, -5, 25)),
      surface('landuse', square(-15, -25, 30, 25), { leisure: 'park' }),
      surface('landuse', square(-45, -40, 45, 40), { landuse: 'retail' }),
    ],
    route: { points: [[-55, 0], [55, 0], [45, 20]] },
  }));
  assertDisjoint({ asphalt: streets.asphalt, pedestrian: streets.pedestrian, curb: streets.curb, ...streets.surfaces });
  assert.ok(contains(streets.surfaces.water, [-20, 15]));
  assert.ok(contains(streets.surfaces.green, [5, 15]));
  assert.ok(contains(streets.surfaces.paving, [-35, 25]));
  assert.ok(streets.route.band.length && streets.route.core.length);
  assertDisjoint({ routeBand: streets.route.band, routeCore: streets.route.core });
  for (const polygons of [...Object.values(streets.surfaces), streets.route.band, streets.route.core]) {
    assert.ok(intersectArea(polygons, [building.rings]) < 1e-5);
    assert.ok(measure(clipping.difference(polygons, [[square(-50, -50, 50, 50)]])) < 1e-5);
  }
});

test('real Chunxi street snapshot has no material overlap, solid-building intrusion or out-of-district road buffer', async t => {
  let source;
  try { source = JSON.parse(await readFile(new URL('../output/scene.geojson', import.meta.url), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('local downloaded scene is not present'); throw error; }
  const prepared = prepareScene(source), original = JSON.stringify(prepared.roads);
  const streets = buildStreetTopology(prepared), [west, north, east, south] = prepared.bounds;
  assert.equal(JSON.stringify(prepared.roads), original, 'render repair must preserve real geographic source segments');
  assert.ok(streets.groundRoads.length > 100);
  assert.ok(streets.groundRoads.length < prepared.roads.length, 'roof and tunnel paths must not be drawn as ground roads');
  const groundBuildings = prepared.buildings.filter(isGroundBuilding);
  const solids = groundBuildings.length ? clipping.union(...groundBuildings.map(building => building.rings)) : [];
  const territory = [[square(west, north, east, south)]];
  const layers = { asphalt: streets.asphalt, pedestrian: streets.pedestrian, curb: streets.curb, ...streets.surfaces };
  assertDisjoint(layers, 1e-3);
  for (const [name, polygons] of Object.entries({ ...layers, markings: streets.markings, routeBand: streets.route.band, routeCore: streets.route.core })) {
    assert.ok(intersectArea(polygons, solids) < 1e-3, `${name} enters a building`);
    assert.ok(measure(clipping.difference(polygons, territory)) < 1e-3, `${name} exceeds requested map bounds`);
    for (const coordinate of polygons.flat(2)) assert.ok(coordinate.every(Number.isFinite), `${name} has an invalid vertex`);
  }
});
