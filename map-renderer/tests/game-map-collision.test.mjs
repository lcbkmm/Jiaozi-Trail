import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCameraClearance } from '../game-map-collision.mjs';
import { gabledRoofGeometry, roofFixtureFits } from '../game-map-scene.mjs';

const rectangle = (x0, z0, x1, z1, displayHeight = 10) => ({ rings: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]], displayHeight });
const point = (x, y, z) => ({ x, y, z });
const near = (a, b, tolerance = .001) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('swept clearance stops a large step through a thin building with both endpoints outdoors', () => {
  const result = resolveCameraClearance(point(-20, 5, 0), point(20, 5, 0), [rectangle(0, -10, .2, 10)]);
  near(result.x, -1.2); near(result.y, 5); near(result.z, 0);
});

test('wall collisions retain movement along the wall instead of raising the camera', () => {
  const result = resolveCameraClearance(point(-5, 5, 2), point(5, 5, 8), [rectangle(0, 0, 10, 10)]);
  near(result.x, -1.2); near(result.y, 5); near(result.z, 8);
});

test('rounded corner clearance prevents a diagonal near-plane intersection', () => {
  const result = resolveCameraClearance(point(-5, 5, -5), point(5, 5, 5), [rectangle(0, 0, 10, 10)]);
  near(result.x, -1.2 / Math.sqrt(2)); near(result.z, -1.2 / Math.sqrt(2)); near(result.y, 5);
});

test('clearance applies even while the camera center stays outside the footprint', () => {
  const result = resolveCameraClearance(point(-5, 5, 5), point(-.3, 5, 5), [rectangle(0, 0, 10, 10)]);
  near(result.x, -1.2);
});

test('parallel movement at the clearance boundary does not stick or drift', () => {
  const goal = point(-1.2, 5, 9);
  assert.deepEqual(resolveCameraClearance(point(-1.2, 5, 1), goal, [rectangle(0, 0, 10, 10)]), goal);
});

test('courtyard interiors remain available while courtyard walls keep their clearance', () => {
  const building = rectangle(0, 0, 30, 30);
  building.rings.push([[10, 10], [20, 10], [20, 20], [10, 20]]);
  const goal = point(16, 5, 17);
  assert.deepEqual(resolveCameraClearance(point(15, 5, 15), goal, [building]), goal);
  const hit = resolveCameraClearance(point(15, 5, 15), point(25, 5, 15), [building]);
  near(hit.x, 18.8); near(hit.y, 5);
});

test('flying above the roof clears the building without changing requested movement', () => {
  const goal = point(20, 25, 5);
  assert.deepEqual(resolveCameraClearance(point(-10, 25, 5), goal, [rectangle(0, 0, 10, 10)]), goal);
});

test('vertical descent stops above the rendered roof and near-plane allowance', () => {
  const hit = resolveCameraClearance(point(5, 30, 5), point(5, 0, 5), [rectangle(0, 0, 10, 10)]);
  near(hit.x, 5); near(hit.z, 5); near(hit.y, 11.7);
});

test('roof collision is checked during a diagonal descent, even after entering from above', () => {
  const hit = resolveCameraClearance(point(-10, 25, 5), point(20, 5, 5), [rectangle(0, 0, 10, 10)]);
  near(hit.x, 20); near(hit.z, 5); near(hit.y, 11.7);
});

test('an already embedded previous camera is safely repaired above overlapping buildings', () => {
  const buildings = [rectangle(0, 0, 10, 10, 40), rectangle(0, 0, 10, 10, 15)];
  const hit = resolveCameraClearance(point(5, 5, 5), point(6, 5, 5), buildings);
  near(hit.x, 6); near(hit.y, 41.7); near(hit.z, 5);
});

test('a stationary embedded camera is repaired without requiring movement', () => {
  const previous = point(5, 5, 5), building = rectangle(0, 0, 10, 10);
  const hit = resolveCameraClearance(previous, previous, [building]);
  near(hit.x, 5); near(hit.z, 5); near(hit.y, 11.7);
  const settled = resolveCameraClearance(hit, hit, [building]);
  assert.deepEqual(settled, hit, 'a safely repaired stationary camera must remain stable');
});

test('roof clearance stays above actual broad and narrow rendered gable vertices', () => {
  for (const width of [4, 40]) {
    const building = rectangle(0, 0, width, 50);
    building.tags = { 'roof:shape': 'gabled' };
    const geometry = gabledRoofGeometry(building); geometry.computeBoundingBox();
    const top = geometry.boundingBox.max.y; geometry.dispose();
    const p = point(width / 2, 5, 25), hit = resolveCameraClearance(p, p, [building]);
    assert.ok(hit.y >= top + 1.2 - 1e-5, 'the near plane must clear every gable vertex');
    assert.ok(hit.y < top + 1.202, 'narrow gables should not use the maximum roof rise');
    near(hit.x, p.x); near(hit.z, p.z);
  }
});

test('flat roofs reserve equipment height only when the renderer can place fixtures', () => {
  const fixtures = { ...rectangle(0, 0, 20, 20), id: 'fixture', center: [10, 10], tags: {} };
  const noFixtures = { ...fixtures, id: 'c' }; // Renderer hash is divisible by four.
  const narrow = { ...rectangle(0, 0, 4, 20), id: 'fixture', center: [2, 10], tags: {} };
  assert.ok(roofFixtureFits(fixtures, fixtures.center, 5.5, 3.8));
  assert.ok(!roofFixtureFits(narrow, narrow.center, 5.5, 3.8));
  const hit = resolveCameraClearance(point(10, 5, 10), point(10, 5, 10), [fixtures]);
  assert.ok(hit.y >= fixtures.displayHeight + 2.95 + 1.2, 'clear the highest visible vent');
  near(hit.y, 14.2);
  near(resolveCameraClearance(point(10, 5, 10), point(10, 5, 10), [noFixtures]).y, 11.7);
  near(resolveCameraClearance(point(2, 5, 10), point(2, 5, 10), [narrow]).y, 11.7);
});

test('consecutive obstacles constrain sliding without tunneling through the second wall', () => {
  const hit = resolveCameraClearance(point(-5, 5, -5), point(10, 5, 15), [rectangle(0, 0, 10, 10), rectangle(-20, 10, 0, 11)]);
  assert.ok(hit.x <= -1.2 + .001); assert.ok(hit.z <= 8.8 + .001); near(hit.y, 5);
});

test('zero clearance still detects an exact thin-wall crossing', () => {
  const hit = resolveCameraClearance(point(-5, 5, 5), point(15, 5, 5), [rectangle(0, 0, .2, 10)], 0);
  near(hit.x, 0); near(hit.y, 5);
});

test('collision resolution does not mutate vectors or building geometry', () => {
  const previous = Object.freeze(point(-5, 5, 5)), desired = Object.freeze(point(5, 5, 5));
  const building = rectangle(0, 0, 10, 10), before = JSON.stringify(building);
  for (const ring of building.rings) { ring.forEach(Object.freeze); Object.freeze(ring); }
  Object.freeze(building.rings); Object.freeze(building);
  const result = resolveCameraClearance(previous, desired, Object.freeze([building]));
  assert.notEqual(result, previous); assert.notEqual(result, desired); assert.equal(JSON.stringify(building), before);
  assert.deepEqual(previous, point(-5, 5, 5)); assert.deepEqual(desired, point(5, 5, 5));
});
