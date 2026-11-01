import test from 'node:test';
import assert from 'node:assert/strict';
import { createExploration, createExplorationOverlay } from '../game-map-exploration.mjs';

const place = (id, position, name = id, extra = {}) => ({ id, position, name, source: 'Baidu Place API', coordinate: [104.07 + position[0] / 100000, 30.65 - position[1] / 100000], ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `expected ${expected}, received ${actual}`);

test('route stations retain true place positions and project to the full continuous route in metres', () => {
  const places = [place('first', [20, 12]), place('corner', [110, 60]), place('far', [50, 40])];
  const original = JSON.stringify(places), routePoints = [[0, 0], [100, 0], [100, 100]];
  const exploration = createExploration({ places, routePoints });
  near(exploration.length, 200);
  assert.deepEqual(exploration.stations.map(s => s.id), ['first', 'corner']);
  assert.deepEqual(exploration.stations[0].position, [20, 12]);
  assert.deepEqual(exploration.stations[0].routePosition, [20, 0]);
  near(exploration.stations[0].distance, 20); near(exploration.stations[0].offset, 12);
  near(exploration.stations[1].distance, 160); near(exploration.stations[1].offset, 10);
  assert.equal(JSON.stringify(places), original);
});

test('nearby stops prefer real POIs, then featured landmarks, and remain at least 25 route metres apart', () => {
  const building = { id: 'way-10-0', displayHeight: 12 };
  const exploration = createExploration({ routePoints: [[0, 0], [200, 0]], places: [
    place(building.id, [10, 0], 'IFS虚构建筑条目', { building }),
    place('real', [20, 20], '真实店铺'),
    place('ordinary', [65, 0], '普通店铺'),
    place('featured', [80, 10], '成都IFS国际金融中心'),
    place('next', [105, 0], '下一家'),
    place('outside', [160, 32.01], '太古里'),
  ] });
  assert.deepEqual(exploration.stations.map(s => s.id), ['real', 'featured', 'next']);
  assert.equal(exploration.stations[0].realPOI, true);
  assert.equal(exploration.stations[1].featured, true);
  assert.equal(exploration.stations[2].distance - exploration.stations[1].distance, 25, 'exactly 25m is allowed');
  const onlyBuilding = createExploration({ routePoints: [[0, 0], [50, 0]], places: [place(building.id, [20, 0], '命名建筑', { building })] });
  assert.equal(onlyBuilding.stations.length, 1, 'a building remains a fallback when no nearby real POI exists');
  assert.equal(onlyBuilding.stations[0].realPOI, false);
});

test('visits are explicit, copied state and only unvisited stations interrupt a route once per session', () => {
  const places = [place('a', [20, 0]), place('b', [60, 0]), place('c', [100, 0])], visited = new Set(['a']);
  const exploration = createExploration({ places, routePoints: [[0, 0], [120, 0]], visited });
  visited.add('b'); // Later changes to caller-owned state are applied explicitly.
  assert.equal(exploration.nextUnvisited().id, 'b');
  const seen = new Set();
  assert.equal(exploration.encounter(0, 120, seen).id, 'b');
  assert.deepEqual([...seen], ['b']);
  assert.equal(exploration.nextUnvisited().id, 'b', 'encounter does not silently visit a location');
  assert.equal(exploration.encounter(0, 120, seen).id, 'c');
  assert.equal(exploration.encounter(0, 120, seen), null);
  exploration.setVisited(['a', 'b', 'c']);
  assert.equal(exploration.nextUnvisited(), null);
  assert.equal(exploration.encounter(0, 120, new Set()), null);
  exploration.setVisited([]);
  assert.equal(exploration.nextUnvisited(21).id, 'b');
  assert.equal(exploration.nextUnvisited(121), null);
  assert.equal(exploration.encounter(120, 0, new Set()).id, 'c', 'reverse travel encounters the nearest stop in that direction');
});

test('route switching reprojects stations and repeated route segments cannot duplicate one location', () => {
  const places = [place('a', [30, 10]), place('b', [150, 10])];
  const first = createExploration({ places, routePoints: [[0, 0], [100, 0], [0, 0]] });
  assert.deepEqual(first.stations.map(s => s.id), ['a']);
  near(first.stations[0].distance, 30);
  const second = createExploration({ places, routePoints: [[100, 10], [200, 10]], visited: ['b'] });
  assert.deepEqual(second.stations.map(s => s.id), ['b']); near(second.stations[0].distance, 50);
  assert.equal(second.encounter(0, 100, new Set()), null);
  assert.equal(createExploration({ places, routePoints: [[0, 0], [0, 0]] }).stations.length, 0);
  assert.equal(createExploration({ places, routePoints: [] }).nextUnvisited(), null);
  assert.equal(createExploration({ places, routePoints: [[0, 0], null, [100, 0]] }).stations.length, 0, 'invalid points cannot invent a connecting segment');
});

test('visited-only 3D markers preserve geographic anchors and have real depth occlusion', () => {
  const building = { id: 'tower', displayHeight: 28, rings: [[[0, 0], [20, 0], [20, 20], [0, 20]]], tags: {} };
  const ground = place('ground', [30, 15]), roof = place('roof', [10, 12], '屋顶地点', { building });
  const source = JSON.stringify([ground, roof]), overlay = createExplorationOverlay([ground, roof]);
  assert.equal(overlay.root.children.length, 0, 'unvisited places have no 3D markers');
  overlay.setVisited(['roof', 'missing']);
  assert.equal(overlay.root.children.length, 1);
  const marker = overlay.root.children[0];
  assert.equal(marker.userData.placeId, 'roof');
  near(marker.position.x, 10); near(marker.position.z, 12); near(marker.position.y, 29.47);
  assert.deepEqual(marker.userData.coordinate, roof.coordinate);
  marker.traverse(node => { if (node.isMesh) { assert.equal(node.material.depthTest, true); assert.equal(node.material.depthWrite, true); } });
  overlay.setVisited(['roof', 'ground']); assert.equal(overlay.root.children.length, 2);
  const groundMarker = overlay.root.children.find(node => node.userData.placeId === 'ground');
  near(groundMarker.position.x, 30); near(groundMarker.position.z, 15); near(groundMarker.position.y, .38);
  overlay.setVisited(['ground']); assert.equal(overlay.root.children.length, 1);
  overlay.setVisited([]); assert.equal(overlay.root.children.length, 0);
  assert.equal(JSON.stringify([ground, roof]), source);
  overlay.dispose(); assert.equal(overlay.root.children.length, 0);
});

test('roof landmarks clear pitched roofs and do not float over an unrelated attached building', () => {
  const building = { id: 'roof', displayHeight: 10, rings: [[[0, 0], [20, 0], [20, 20], [0, 20]]], tags: { 'roof:shape': 'gabled' } };
  const inside = place('inside', [10, 10], '真实屋顶点', { building });
  const outside = place('outside', [30, 30], '建筑之外', { building });
  const overlay = createExplorationOverlay([inside, outside]); overlay.setVisited(['inside', 'outside']);
  const a = overlay.root.children.find(node => node.userData.placeId === 'inside');
  const b = overlay.root.children.find(node => node.userData.placeId === 'outside');
  assert.ok(a.position.y >= building.displayHeight + 4.2 + 1.2);
  near(b.position.y, .38); near(b.position.x, 30); near(b.position.z, 30);
  overlay.dispose();
});
