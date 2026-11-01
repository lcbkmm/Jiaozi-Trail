import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import clipping from '../assets/vendor/polyclip-ts.mjs';
import { buildBuildingTopology, createBuildingClearance } from '../game-map-buildings.mjs';
import { area, pointInRing, prepareScene } from '../game-map-model.mjs';

const square = (w, n, e, s) => [[w, n], [e, n], [e, s], [w, s]];
const building = (id, ring, top = 10, bottom = 0) => ({ id, rings: [ring], displayHeight: top, displayBaseHeight: bottom });
const measure = polygons => polygons.reduce((sum, rings) => sum + Math.abs(area(rings[0])) - rings.slice(1).reduce((holes, ring) => holes + Math.abs(area(ring)), 0), 0);
const wallArea = walls => walls.reduce((sum, wall) => sum + Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) * (wall.top - wall.bottom), 0);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message || ''} expected ${expected}, received ${actual}`);
const matchesX = (wall, x) => Math.abs(wall.a[0] - x) < 1e-7 && Math.abs(wall.b[0] - x) < 1e-7;
const contains = (rings, point) => pointInRing(point, rings[0]) && !rings.slice(1).some(ring => pointInRing(point, ring));

test('isolated source walls and courtyard normals remain correct for either winding without moving source rings', () => {
  for (const reverse of [false, true]) {
    const source = building('a', square(0, 0, 10, 10));
    source.rings.push(square(3, 3, 7, 7));
    if (reverse) source.rings.forEach(ring => ring.reverse());
    const before = JSON.stringify(source), topology = buildBuildingTopology([source]).get('a');
    assert.equal(JSON.stringify(source), before);
    near(measure(topology.roofs), 84);
    near(wallArea(topology.walls), 560);
    assert.equal(topology.walls.length, 8);
    for (const wall of topology.walls) {
      const mid = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
      assert.ok(!contains(source.rings, mid.map((v, i) => v + wall.normal[i] * .001)), 'normal must point to open exterior or courtyard');
      assert.ok(contains(source.rings, mid.map((v, i) => v - wall.normal[i] * .001)), 'solid must remain on the opposite side');
    }
  }
});

test('partial shared walls split at actual neighbour endpoints and retain only exposed heights', () => {
  const a = building('a', square(0, 0, 10, 10), 10);
  const b = building('b', square(10, 3, 15, 7), 20);
  const topology = buildBuildingTopology([a, b]);
  near(wallArea(topology.get('a').walls), 360);
  near(wallArea(topology.get('b').walls), 320);
  const wallsA = topology.get('a').walls.filter(wall => matchesX(wall, 10));
  assert.equal(wallsA.length, 2);
  assert.deepEqual(wallsA.map(wall => [wall.a[1], wall.b[1]]), [[0, 3], [7, 10]]);
  const wallsB = topology.get('b').walls.filter(wall => matchesX(wall, 10));
  assert.equal(wallsB.length, 1);
  assert.equal(wallsB[0].bottom, 10); assert.equal(wallsB[0].top, 20);
});

test('overlapping equal roofs and same-side coplanar exterior walls have one stable owner', () => {
  const a = building('a', square(0, 0, 10, 10)), b = building('b', square(5, 0, 15, 10));
  const before = JSON.stringify([a, b]), first = buildBuildingTopology([a, b]), reversed = buildBuildingTopology([b, a]);
  assert.equal(JSON.stringify([a, b]), before);
  near(measure(first.get('a').roofs), 100); near(measure(first.get('b').roofs), 50);
  near(measure(clipping.intersection(first.get('a').roofs, first.get('b').roofs)), 0);
  near(wallArea(first.get('a').walls) + wallArea(first.get('b').walls), 500);
  assert.deepEqual(first.get('a'), reversed.get('a'));
  assert.deepEqual(first.get('b'), reversed.get('b'));
  assert.ok(!first.get('a').walls.some(wall => matchesX(wall, 10)), 'internal wall is removed');
  assert.ok(!first.get('b').walls.some(wall => matchesX(wall, 5)), 'other internal wall is removed');
  const duplicate = buildBuildingTopology([a, { ...structuredClone(a), id: 'c' }]);
  near(measure(duplicate.get('c').roofs), 0);
  near(wallArea(duplicate.get('c').walls), 0);
});

test('different heights and non-collinear crossings cut wall interiors and covered roofs', () => {
  const a = building('a', square(0, 0, 10, 10), 10);
  const b = building('b', [[5, -5], [15, 5], [5, 15], [-5, 5]], 20);
  const topology = buildBuildingTopology([a, b]);
  near(measure(topology.get('a').roofs), 0);
  near(measure(topology.get('b').roofs), 200);
  near(wallArea(topology.get('a').walls), 0);
  // All diamond wall spans below 10 remain outside or only touch the square.
  near(wallArea(topology.get('b').walls), 4 * Math.sqrt(200) * 20);
  const shifted = building('c', square(5, 2, 15, 8), 20);
  const cross = buildBuildingTopology([a, shifted]);
  near(measure(cross.get('a').roofs), 70);
  const sharedX = cross.get('a').walls.filter(wall => matchesX(wall, 10));
  assert.deepEqual(sharedX.map(wall => [wall.a[1], wall.b[1]]), [[0, 2], [8, 10]]);
});

test('raised buildings preserve undercroft gaps and do not infer a base from layer', () => {
  const lower = building('a', square(0, 0, 10, 10), 5);
  const upper = building('b', square(0, 0, 10, 10), 12, 8);
  upper.tags = { layer: '4' };
  const topology = buildBuildingTopology([lower, upper]);
  near(measure(topology.get('a').roofs), 100); near(measure(topology.get('b').roofs), 100);
  near(wallArea(topology.get('a').walls), 200); near(wallArea(topology.get('b').walls), 160);
  assert.equal(topology.get('b').bottom, 8);
  const onlyLayer = { ...upper, id: 'layer-only', displayBaseHeight: undefined };
  assert.equal(buildBuildingTopology([onlyLayer]).get('layer-only').bottom, 0);
  const touching = { ...upper, displayBaseHeight: 5 };
  near(measure(buildBuildingTopology([lower, touching]).get('a').roofs), 0, 'touching upper solid covers the lower roof');
  const beside = building('c', square(10, 3, 15, 7), 15, 5);
  const adjacent = buildBuildingTopology([building('a', lower.rings[0], 10), beside]);
  const lowerShared = adjacent.get('a').walls.filter(wall => matchesX(wall, 10) && wall.a[1] === 3 && wall.b[1] === 7);
  assert.equal(lowerShared.length, 1); assert.equal(lowerShared[0].bottom, 0); assert.equal(lowerShared[0].top, 5);
  const upperShared = adjacent.get('c').walls.filter(wall => matchesX(wall, 10));
  assert.equal(upperShared.length, 1); assert.equal(upperShared[0].bottom, 10); assert.equal(upperShared[0].top, 15);
});

test('district clipping cannot turn zero-area backtracking source bridges into visible walls', () => {
  // One clipped source ring describes two disjoint blocks connected only by a
  // retraced border segment. It stays one source owner, with two roof pieces.
  const source = building('clipped', [[0, 0], [4, 0], [4, 2], [0, 2], [0, 6], [4, 6], [4, 8], [0, 8]]);
  const before = JSON.stringify(source.rings), record = buildBuildingTopology([source]).get(source.id);
  assert.equal(JSON.stringify(source.rings), before);
  assert.equal(record.roofs.length, 2);
  near(measure(record.roofs), 16);
  near(wallArea(record.walls), 240, 'only the two real block perimeters remain');
  assert.ok(!record.walls.some(w => matchesX(w, 0) && Math.min(w.a[1], w.b[1]) < 6 && Math.max(w.a[1], w.b[1]) > 2), 'zero-area connection has no wall');
});

test('full oriented-box clearance catches rotation, thin crossing edges, enclosing fixtures and own-volume policy', () => {
  const owner = building('owner', square(-10, -10, -5, -5));
  const neighbour = building('neighbour', square(-.2, -.2, .2, .2));
  const clearance = createBuildingClearance([owner, neighbour]);
  assert.equal(clearance.fits(owner, { position: [-2, 2, 2], size: [8, 2, .1], yaw: Math.PI / 4 }, { allowOwn: true }), false,
    'thin box crosses a neighbour although its centre and all corners are outside');
  assert.equal(clearance.fits(owner, { position: [0, 2, 0], size: [10, 2, 10] }, { allowOwn: true }), false,
    'a building completely enclosed by a fixture cannot be missed');
  assert.equal(clearance.fits(owner, { position: [-7, 2, -7], size: [1, 1, 1] }), false);
  assert.equal(clearance.fits(owner, { position: [-7, 2, -7], size: [1, 1, 1] }, { allowOwn: true }), true);
  const side = building('side', square(2.1, -.2, 2.5, .2));
  const rotation = createBuildingClearance([side]);
  assert.equal(rotation.fits(null, { position: [0, 1, 0], size: [6, 2, .1] }), false);
  assert.equal(rotation.fits(null, { position: [0, 1, 0], size: [6, 2, .1], yaw: Math.PI / 2 }), true);
});

test('clearance respects courtyards, suspended volumes, exact flush contact and vertical separation', () => {
  const court = building('court', square(0, 0, 10, 10)); court.rings.push(square(3, 3, 7, 7));
  const clearance = createBuildingClearance([court]);
  assert.equal(clearance.fits(null, { position: [5, 2, 5], size: [3.9, 2, 3.9] }), true);
  assert.equal(clearance.fits(null, { position: [5, 2, 5], size: [4.2, 2, 4.2] }), false);
  assert.equal(clearance.fits(null, { position: [5, 11, 5], size: [10, 2, 10] }), true, 'touching a roof is allowed');
  assert.equal(clearance.fits(null, { position: [11, 2, 5], size: [2, 2, 2] }), true, 'flush wall contact is allowed');
  assert.equal(clearance.fits(null, { position: [10.99, 2, 5], size: [2, 2, 2] }), false);
  const raised = createBuildingClearance([building('raised', square(0, 0, 10, 10), 12, 8)]);
  assert.equal(raised.fits(null, { position: [5, 4, 5], size: [2, 8, 2] }), true);
  assert.equal(raised.fits(null, { position: [5, 4.01, 5], size: [2, 8, 2] }), false);
});

test('complete roof support checks rotated edges, concave cutouts and enclosed courtyard holes', () => {
  const court = building('court', square(0, 0, 10, 10)); court.rings.push(square(4.9, 4.9, 5.1, 5.1));
  const support = createBuildingClearance([court]);
  assert.equal(support.containsFootprint(court, { position: [2, 11, 2], size: [2, 2, 2], yaw: Math.PI / 4 }), true);
  assert.equal(support.containsFootprint(court, { position: [5, 11, 5], size: [8, 2, 8] }), false, 'an enclosed courtyard is unsupported even with all box corners inside the solid');
  assert.equal(support.containsFootprint(court, { position: [1, 11, 1], size: [2, 2, 2], yaw: Math.PI / 4 }), false, 'rotation can put a corner outside');
  const concave = building('l', [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]]);
  assert.equal(createBuildingClearance([concave]).containsFootprint(concave, { position: [3, 11, 3], size: [4, 2, 4] }), false);
  const footprint = support.footprint({ position: [2, 1, 3], size: [4, 2, 2], yaw: Math.PI / 2 });
  near(Math.min(...footprint.map(p => p[0])), 1); near(Math.max(...footprint.map(p => p[0])), 3);
  near(Math.min(...footprint.map(p => p[1])), 1); near(Math.max(...footprint.map(p => p[1])), 5);
});

test('actual Chunxi source roofs have no duplicate owner or taller-volume intrusion and source coordinates are unchanged', async () => {
  const geojson = JSON.parse(await readFile(new URL('../output/scene.geojson', import.meta.url), 'utf8'));
  const model = prepareScene(geojson), before = JSON.stringify(model.buildings.map(b => b.rings));
  const topology = buildBuildingTopology(model.buildings);
  assert.equal(topology.size, model.buildings.length);
  assert.equal(JSON.stringify(model.buildings.map(b => b.rings)), before);
  const bounds = b => [Math.min(...b.rings[0].map(p => p[0])), Math.min(...b.rings[0].map(p => p[1])), Math.max(...b.rings[0].map(p => p[0])), Math.max(...b.rings[0].map(p => p[1]))];
  const bboxes = new Map(model.buildings.map(b => [b.id, bounds(b)]));
  const overlap = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  let sourceOverlap = 0, hiddenWallArea = 0;
  for (let i = 0; i < model.buildings.length; i++) {
    const source = model.buildings[i], record = topology.get(source.id);
    near(measure(clipping.difference(record.roofs, [source.rings])), 0, 'roof stays inside exact source footprint');
    for (let j = i + 1; j < model.buildings.length; j++) {
      const other = model.buildings[j]; if (!overlap(bboxes.get(source.id), bboxes.get(other.id))) continue;
      sourceOverlap += measure(clipping.intersection([source.rings], [other.rings]));
      const neighbour = topology.get(other.id);
      if (Math.abs(record.top - neighbour.top) < 1e-8) assert.ok(measure(clipping.intersection(record.roofs, neighbour.roofs)) < 1e-5, `${source.id}/${other.id} duplicated coplanar roof`);
      for (const [a, b, buildingB] of [[record, neighbour, other], [neighbour, record, source]]) {
        if (b.bottom <= a.top && b.top > a.top + 1e-8) assert.ok(measure(clipping.intersection(a.roofs, [buildingB.rings])) < 1e-5, 'roof must not enter a taller volume');
      }
    }
    const length = source.rings.reduce((sum, ring) => sum + ring.reduce((len, a, k) => len + Math.hypot(a[0] - ring[(k + 1) % ring.length][0], a[1] - ring[(k + 1) % ring.length][1]), 0), 0);
    hiddenWallArea += length * (record.top - record.bottom) - wallArea(record.walls);
    for (const wall of record.walls) {
      assert.ok(wall.top > wall.bottom && wall.bottom >= record.bottom && wall.top <= record.top);
      assert.ok(wall.a.concat(wall.b, wall.normal).every(Number.isFinite));
    }
  }
  assert.ok(sourceOverlap > 650 && sourceOverlap < 660, 'audit exercises the known real source footprint overlaps');
  assert.ok(hiddenWallArea > 10000, 'shared and overlapping source facades must actually be suppressed');
  // An independent union of each horizontal solid cross-section catches both
  // false party walls and zero-area source backtracking at district boundaries.
  const heights = [...new Set(model.buildings.flatMap(b => [b.displayBaseHeight || 0, b.displayHeight]))].sort((a, b) => a - b);
  for (let i = 1; i < heights.length; i++) {
    const y = (heights[i - 1] + heights[i]) / 2;
    const active = model.buildings.filter(b => (b.displayBaseHeight || 0) < y && b.displayHeight > y);
    const boundary = clipping.union(...active.map(b => b.rings));
    const perimeter = boundary.reduce((sum, polygon) => sum + polygon.reduce((s, ring) => s + ring.reduce((p, a, j) => {
      const b = ring[(j + 1) % ring.length]; return p + Math.hypot(a[0] - b[0], a[1] - b[1]);
    }, 0), 0), 0);
    let visibleWallLength = 0;
    for (const record of topology.values()) for (const wall of record.walls) if (wall.bottom < y && wall.top > y) {
      visibleWallLength += Math.hypot(wall.a[0] - wall.b[0], wall.a[1] - wall.b[1]);
    }
    assert.ok(Math.abs(visibleWallLength - perimeter) < 1e-5, `at height ${y}, exposed source walls must exactly cover the solid union perimeter: ${visibleWallLength - perimeter}m error`);
  }
});
