import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocationTracker } from '../location.mjs';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const fix = (longitude = 104.08, latitude = 30.66, accuracy = 7.25) => ({ coords: { longitude, latitude, accuracy } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function geolocation() {
  const watches = [], cleared = [];
  return {
    watches, cleared,
    watchPosition(success, error, options) { watches.push({ success, error, options }); return watches.length - 1; },
    clearWatch(id) { cleared.push(id); },
  };
}
function harness(convert = coordinate => Promise.resolve({ coordinate, method: 'baidu' })) {
  const geo = geolocation(), positions = [], errors = [], states = [];
  const tracker = createLocationTracker({ geolocation: geo, convert,
    onPosition: position => positions.push(position), onError: error => errors.push(error), onState: active => states.push(active) });
  return { geo, tracker, positions, errors, states };
}

test('watch starts only on demand; repeated start/stop preserves a single watcher', () => {
  const { geo, tracker, states } = harness();
  assert.equal(geo.watches.length, 0);
  assert.equal(tracker.isActive(), false);
  assert.equal(tracker.start(), true);
  assert.equal(tracker.start(), true);
  assert.equal(geo.watches.length, 1);
  assert.deepEqual(geo.watches[0].options, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
  assert.equal(tracker.stop(), true);
  assert.equal(tracker.stop(), false);
  assert.deepEqual(geo.cleared, [0]);
  assert.deepEqual(states, [true, false]);
});

test('slow conversions keep updating despite multiple more recent pending fixes', async () => {
  const pending = [];
  const { geo, tracker, positions } = harness(input => { const item = deferred(); pending.push({ ...item, input }); return item.promise; });
  tracker.start();
  geo.watches[0].success(fix(104.081, 30.661, 3.75));
  geo.watches[0].success(fix(104.082, 30.662, 8.5));
  geo.watches[0].success(fix(104.083, 30.663, 11.25));
  pending[0].resolve({ coordinate: [104.091, 30.671], method: 'baidu' });
  await flush();
  assert.deepEqual(positions, [{ coordinate: [104.091, 30.671], accuracy: 3.75, method: 'baidu' }]);
  pending[1].resolve({ coordinate: [104.092, 30.672], method: 'local' });
  await flush();
  assert.equal(positions.length, 2);
  assert.equal(positions[1].accuracy, 8.5);
  assert.equal(positions[1].method, 'local');
  pending[2].resolve({ coordinate: [104.093, 30.673], method: 'baidu' });
  await flush();
  assert.equal(positions.length, 3);
});

test('an older conversion cannot overwrite a newer applied position', async () => {
  const a = deferred(), b = deferred(), conversions = [a, b];
  const { geo, tracker, positions, errors } = harness(() => conversions.shift().promise);
  tracker.start();
  geo.watches[0].success(fix(104.081));
  geo.watches[0].success(fix(104.082));
  b.resolve({ coordinate: [104.092, 30.66], method: 'baidu' });
  await flush();
  a.resolve({ coordinate: [104.091, 30.66], method: 'baidu' });
  await flush();
  assert.deepEqual(positions.map(p => p.coordinate[0]), [104.092]);
  assert.deepEqual(errors, []);
});

test('stop invalidates pending conversion, queued fixes, and queued errors', async () => {
  const pending = deferred();
  let conversions = 0;
  const { geo, tracker, positions, errors } = harness(() => { conversions++; return pending.promise; });
  tracker.start();
  geo.watches[0].success(fix());
  tracker.stop();
  pending.resolve({ coordinate: [104.09, 30.67], method: 'baidu' });
  geo.watches[0].success(fix());
  geo.watches[0].error({ code: 2 });
  await flush();
  assert.deepEqual(positions, []);
  assert.deepEqual(errors, []);
  assert.equal(conversions, 1);
});

test('restart rejects old-session pending results and failures without stopping the new session', async () => {
  const oldResult = deferred(), oldError = deferred(), newResult = deferred();
  const conversions = [oldResult, oldError, newResult];
  const { geo, tracker, positions, errors, states } = harness(() => conversions.shift().promise);
  tracker.start();
  geo.watches[0].success(fix());
  geo.watches[0].success(fix());
  tracker.stop();
  tracker.start();
  geo.watches[1].success(fix(104.09));
  oldResult.resolve({ coordinate: [104.08, 30.66], method: 'baidu' });
  oldError.reject(new Error('obsolete request'));
  geo.watches[0].error({ code: 1 });
  newResult.resolve({ coordinate: [104.10, 30.67], method: 'local' });
  await flush();
  assert.deepEqual(positions, [{ coordinate: [104.10, 30.67], accuracy: 7.25, method: 'local' }]);
  assert.deepEqual(errors, []);
  assert.equal(tracker.isActive(), true);
  assert.deepEqual(states, [true, false, true]);
});

test('permission denial reports original error and clears watcher; transient errors retain watch', () => {
  const { geo, tracker, errors, states } = harness();
  tracker.start();
  const transient = { code: 3, message: 'Timed out' }, denied = { code: 1, message: 'Denied' };
  geo.watches[0].error(transient);
  assert.equal(tracker.isActive(), true);
  geo.watches[0].error(denied);
  assert.equal(tracker.isActive(), false);
  assert.deepEqual(geo.cleared, [0]);
  assert.deepEqual(errors, [transient, denied]);
  assert.deepEqual(states, [true, false]);
});

test('synchronous permission denial before watch ID returns still clears that ID', () => {
  const cleared = [], errors = [], states = [];
  const denied = { code: 1 };
  const tracker = createLocationTracker({ geolocation: {
    watchPosition(success, error) { error(denied); return 0; }, clearWatch(id) { cleared.push(id); },
  }, convert: async coordinate => ({ coordinate, method: 'local' }), onError: error => errors.push(error), onState: state => states.push(state) });
  assert.equal(tracker.start(), false);
  assert.equal(tracker.isActive(), false);
  assert.deepEqual(cleared, [0]);
  assert.deepEqual(errors, [denied]);
  assert.deepEqual(states, [true, false]);
});

test('watch start exceptions and unavailable geolocation report failure without a stuck active state', () => {
  const failure = new Error('watch failed'), errors = [], states = [];
  const tracker = createLocationTracker({ geolocation: { watchPosition() { throw failure; }, clearWatch() {} },
    convert: async coordinate => ({ coordinate, method: 'baidu' }), onError: e => errors.push(e), onState: s => states.push(s) });
  assert.equal(tracker.start(), false);
  assert.equal(tracker.isActive(), false);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(states, [true, false]);
  const missingErrors = [];
  const missing = createLocationTracker({ geolocation: null, convert() {}, onError: e => missingErrors.push(e) });
  assert.equal(missing.start(), false);
  assert.match(missingErrors[0].message, /not available/);
});

test('synchronous and async conversion failures report errors without stopping valid later updates', async () => {
  const sync = new Error('sync'), asyncError = new Error('async');
  let attempt = 0;
  const { geo, tracker, positions, errors } = harness(coordinate => {
    if (++attempt === 1) throw sync;
    if (attempt === 2) return Promise.reject(asyncError);
    return Promise.resolve({ coordinate, method: 'local' });
  });
  tracker.start();
  geo.watches[0].success(fix());
  geo.watches[0].success(fix());
  await flush();
  assert.deepEqual(errors, [sync, asyncError]);
  assert.equal(tracker.isActive(), true);
  geo.watches[0].success(fix());
  await flush();
  assert.equal(positions.length, 1);
});

test('invalid GPS coordinates/accuracy never reach conversion, and invalid converted data never reaches the marker', async () => {
  let conversions = 0;
  const { geo, tracker, positions, errors } = harness(() => { conversions++; return Promise.resolve({ coordinate: [NaN, 30], method: 'baidu' }); });
  tracker.start();
  for (const invalid of [fix(NaN), fix(181), fix(104, 91), fix('104'), fix(104, 30, -1), fix(104, 30, Infinity), {}]) {
    geo.watches[0].success(invalid);
  }
  assert.equal(conversions, 0);
  assert.equal(errors.length, 7);
  geo.watches[0].success(fix());
  await flush();
  assert.equal(conversions, 1);
  assert.equal(errors.length, 8);
  assert.deepEqual(positions, []);
});

test('conversion results must identify the supported coordinate-conversion method', async () => {
  const { geo, tracker, positions, errors } = harness(() => Promise.resolve({ coordinate: [104, 30], method: 'unknown' }));
  tracker.start();
  geo.watches[0].success(fix());
  await flush();
  assert.deepEqual(positions, []);
  assert.match(errors[0].message, /method/);
});
