import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from '../game-map-model.mjs';
import { wgsToGcj } from '../projection.mjs';
import { preparePlanningRoute, createPlanningRouteOverlay } from '../game-map-planning-route.mjs';

const fixture = () => ({ projection: createProjection([104.07, 30.65, 104.09, 30.67]), bounds: [-100, -100, 100, 100], buildings: [] });
const near = (actual, expected, epsilon = 1e-4) => assert.ok(Math.abs(actual - expected) < epsilon, `expected ${expected}, received ${actual}`);
const nearPoint = (actual, expected) => actual.forEach((value, index) => near(value, expected[index]));
const gcj = (model, position) => {
  const [longitude, latitude] = wgsToGcj(...model.projection.unproject(position)); return { longitude, latitude };
};
const leg = (model, positions, extra = {}) => ({ from_place_id: 'a', to_place_id: 'b', coord_system: 'gcj02', source: 'baidu_walking',
  delivery: 'cached', points: positions.map(position => position ? gcj(model, position) : { longitude: NaN, latitude: 30.66 }), ...extra });
const place = (model, id, position, extra = {}) => ({ place_id: id, name: `地点${id}`, coord_system: 'gcj02', ...gcj(model, position), ...extra });

test('planner coordinates convert from GCJ02 to WGS84 exactly once without moving or mutating source places', () => {
  const model = fixture(), places = [place(model, 'a', [-80, 20]), place(model, 'b', [70, -30])];
  const route = { route_id: 'saved-1', stops: [{ place_id: 'a' }, { place_id: 'b' }], legs: [leg(model, [[-80, 20], [0, 10], [70, -30]])] };
  const source = JSON.stringify({ places, route }), data = preparePlanningRoute(route, places, model);
  assert.equal(data.coordinateSystem, 'WGS84'); assert.equal(data.routeId, 'saved-1'); assert.equal(data.runs.length, 1);
  nearPoint(data.runs[0].points[0], [-80, 20]); nearPoint(data.runs[0].points[2], [70, -30]);
  nearPoint(data.stops[0].position, [-80, 20]); nearPoint(data.stops[0].coordinate, model.projection.unproject([-80, 20]));
  assert.ok(Math.hypot(...model.projection.project([places[0].longitude, places[0].latitude]).map((value, index) => value - data.stops[0].position[index])) > 300,
    'the original GCJ02 coordinate must not be projected directly into the WGS84 scene');
  assert.equal(data.stops[0].longitude, places[0].longitude); assert.equal(data.stops[0].coord_system, 'gcj02');
  assert.deepEqual(data.stops.map(stop => [stop.id, stop.sequence, stop.inside]), [['a', 1, true], ['b', 2, true]]);
  near(data.runs[0].length, Math.hypot(80, 10) + Math.hypot(70, 40)); near(data.totalLength, data.runs[0].length);
  assert.equal(data.exits.length, 0); assert.equal(JSON.stringify({ places, route }), source);
});

test('leaving the district and reentering creates disjoint runs and authentic boundary directions', () => {
  const model = fixture(), data = preparePlanningRoute({ stops: [], legs: [leg(model, [[-80, 0], [140, 0], [140, 80], [80, 80]])] }, [], model);
  assert.equal(data.runs.length, 2); nearPoint(data.runs[0].points.at(-1), [100, 0]); nearPoint(data.runs[1].points[0], [100, 80]);
  near(data.totalLength, 200); assert.deepEqual(data.exits.map(exit => exit.kind), ['exit', 'entry']);
  nearPoint(data.exits[0].direction, [1, 0]); nearPoint(data.exits[1].direction, [-1, 0]);
  assert.equal(data.exits[0].toPlaceId, 'b'); assert.equal(data.runs[0].exit, data.exits[0]); assert.equal(data.runs[1].entry, data.exits[1]);
  assert.equal(data.hasOutside, true);
});

test('outside endpoints can cross the district, but touching a corner does not invent a route', () => {
  const model = fixture(), cross = preparePlanningRoute({ legs: [leg(model, [[-160, 0], [160, 0]])] }, [], model);
  assert.equal(cross.runs.length, 1); nearPoint(cross.runs[0].points[0], [-100, 0]); nearPoint(cross.runs[0].points.at(-1), [100, 0]);
  near(cross.totalLength, 200); assert.deepEqual(cross.exits.map(exit => exit.kind), ['entry', 'exit']);
  const touch = preparePlanningRoute({ legs: [leg(model, [[-140, -60], [-100, -100], [-60, -140]])] }, [], model);
  assert.equal(touch.runs.length, 0); assert.equal(touch.exits.length, 0); assert.equal(touch.totalLength, 0);
});

test('exact boundary vertices retain exit and entry events without joining an outside excursion', () => {
  const model = fixture(), data = preparePlanningRoute({ legs: [leg(model, [[-60, 0], [100, 0], [140, 0], [100, 40], [60, 40]])] }, [], model);
  assert.equal(data.runs.length, 2); near(data.totalLength, 200);
  assert.deepEqual(data.exits.map(exit => exit.kind), ['exit', 'entry']);
  nearPoint(data.exits[0].position, [100, 0]); nearPoint(data.exits[1].position, [100, 40]);
});

test('separate legs, missing points, and repeated coordinates cannot create phantom connecting roads', () => {
  const model = fixture(), data = preparePlanningRoute({ legs: [
    leg(model, [[-90, -80], [-50, -80], [-50, -80]], { to_place_id: 'first' }),
    leg(model, [[30, 60], [50, 60], null, [70, 60], [90, 60]], { from_place_id: 'second', to_place_id: 'third' }),
  ] }, [], model);
  assert.equal(data.runs.length, 3); near(data.totalLength, 80);
  assert.deepEqual(data.runs.map(run => [run.fromPlaceId, run.toPlaceId, run.legIndex]), [['a', 'first', 0], ['second', 'third', 1], ['second', 'third', 1]]);
  assert.equal(data.runs[0].points.length, 2); assert.equal(data.exits.length, 0); assert.equal(data.warnings.length, 1);
});

test('outside stops retain their true position; absent paths or unsupported coordinates are not fabricated', () => {
  const model = fixture(), outside = place(model, 'far', [400, 300]);
  const data = preparePlanningRoute({ stops: [{ place_id: 'far' }, { place_id: 'missing', name: '缺少坐标' }], legs: [
    leg(model, [], { source: 'same_location' }), leg(model, [[-10, 0], [10, 0]], { coord_system: 'bd09ll' }),
  ] }, [outside], model);
  nearPoint(data.stops[0].position, [400, 300]); assert.equal(data.stops[0].inside, false);
  assert.equal(data.stops[1].coordinate, null); assert.equal(data.stops[1].position, null); assert.equal(data.stops[1].inside, false);
  assert.equal(data.runs.length, 0); assert.equal(data.exits.length, 0); assert.equal(data.warnings.length, 2);
  assert.deepEqual(preparePlanningRoute(null, [], model).runs, []);
  assert.throws(() => preparePlanningRoute(null, [], {}), /投影及范围/);
});

test('numbered stops and exits are pickable, roof markers clear pitched roofs, and route bands stay in bounds', () => {
  const model = fixture(); model.buildings.push({ rings: [[[0, 0], [20, 0], [20, 20], [0, 20]]], displayHeight: 25, tags: { 'roof:shape': 'gabled' } });
  const places = [place(model, 'inside', [10, 10]), place(model, 'outside', [500, 0])];
  const data = preparePlanningRoute({ stops: [{ place_id: 'inside' }, { place_id: 'outside' }], legs: [leg(model, [[-180, 0], [180, 0]])] }, places, model);
  const overlay = createPlanningRouteOverlay(data), stop = overlay.root.children.find(node => node.userData.planningStop);
  assert.ok(stop); nearPoint([stop.position.x, stop.position.z], [10, 10]); assert.ok(stop.position.y > 29.2);
  stop.traverse(node => assert.equal(node.userData.planningStop, data.stops[0]));
  assert.equal(overlay.root.children.filter(node => node.userData.planningStop).length, 1);
  const badge = stop.children.find(node => node.isSprite); assert.equal(badge.userData.sequence, 1);
  assert.ok(badge.material.map.image.data.some((channel, index) => index % 4 === 3 && channel === 255));
  assert.equal(overlay.root.children.filter(node => node.userData.planningExit).length, 2);
  for (const group of overlay.root.children.filter(node => node.userData.planningExit)) {
    group.traverse(node => assert.equal(node.userData.planningExit, group.userData.planningExit));
  }
  overlay.root.traverse(node => {
    if (node.material) { assert.equal(node.material.depthTest, true); assert.equal(node.material.depthWrite, true); }
    if (!node.parent?.userData.planningRun) return;
    const positions = node.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      assert.ok(positions.getX(i) >= -100.0001 && positions.getX(i) <= 100.0001);
      assert.ok(positions.getZ(i) >= -100.0001 && positions.getZ(i) <= 100.0001);
    }
  });
  const geometries = new Set(), materials = new Set(), textures = new Set();
  overlay.root.traverse(node => {
    if (node.geometry && !node.isSprite) geometries.add(node.geometry);
    if (node.material) { materials.add(node.material); if (node.material.map) textures.add(node.material.map); }
  });
  const disposed = new Set();
  for (const resource of [...geometries, ...materials, ...textures]) resource.addEventListener('dispose', () => { assert.ok(!disposed.has(resource)); disposed.add(resource); });
  overlay.dispose(); overlay.dispose();
  assert.equal(overlay.root.children.length, 0); assert.equal(disposed.size, geometries.size + materials.size + textures.size);
});

test('overlay keeps each clipped run as separate geometry rather than drawing across the missing district part', () => {
  const model = fixture(), data = preparePlanningRoute({ legs: [leg(model, [[-80, -50], [130, -50], [130, 50], [80, 50]])] }, [], model);
  const overlay = createPlanningRouteOverlay(data), groups = overlay.root.children.filter(node => node.userData.planningRun);
  assert.equal(groups.length, 2);
  for (let i = 0; i < groups.length; i++) for (const mesh of groups[i].children) {
    mesh.geometry.computeBoundingBox();
    const z = i === 0 ? -50 : 50;
    assert.ok(mesh.geometry.boundingBox.min.z >= z - 2.201 && mesh.geometry.boundingBox.max.z <= z + 2.201);
  }
  overlay.dispose();
});
