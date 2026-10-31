import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoRegion, posterSize, panelRegion } from '../src/features/fridge-magnet/geometry.ts';
import { newWork } from '../src/features/fridge-magnet/types.ts';
import { MagnetRepository, resetMagnetSample } from '../src/features/fridge-magnet/repository.ts';
test('magnet crop: landscape, portrait, asymmetric focus and small input are aspect preserving and never upscaled', () => {
  assert.deepEqual(photoRegion(1200, 600, { x: 1, y: 0, zoom: 1 }), { x: 300, y: 0, width: 900, height: 600 });
  assert.deepEqual(photoRegion(600, 1200, { x: .5, y: 0, zoom: 1 }), { x: 0, y: 0, width: 600, height: 400 });
  for (const [w, h] of [[2400,1600],[600,1200],[17,11],[12,8],[8,8]]) for (const zoom of [1,2]) {
    const crop = photoRegion(w, h, { x: .8, y: .2, zoom }), size = posterSize(crop.width, crop.height);
    assert.equal(size.width * 4, size.height * 3); assert.equal(size.height % 2, 0);
    assert.ok(size.width <= crop.width); assert.ok(size.height / 2 <= crop.height + 1e-10); assert.ok(size.width <= 1536);
  }
  assert.deepEqual(posterSize(17, 11), { width: 15, height: 20 });
  assert.throws(() => panelRegion(100, 100, { x: .8, y: 0, width: .5, height: 1 }));
});
test('magnet repository: atomic attempt, stale version rejection, byte-perfect blobs, late result ownership and sample isolation', async () => {
  const repo = await MagnetRepository.open(), other = await MagnetRepository.open(), sample = await MagnetRepository.open(true);
  try {
    const blob = new Blob([new Uint8Array([1,4,9])], { type: 'image/png' });
    let work = await repo.save(newWork({ blob, width: 12, height: 8 }, blob, 'journey-test'));
    const attempts = await Promise.allSettled([repo.begin(work, 'request-a'), other.begin(work, 'request-b')]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    work = (await repo.get(work.id))!;
    await assert.rejects(repo.begin(work, 'request-c'));
    await assert.rejects(repo.finish(work.id, 'wrong-request', { error: 'late', uncertain: false }));
    const panel = { blob, width: 12, height: 8, sha256: 'synthetic', provider: 'test-only', model: 'fixture', generatedAt: new Date().toISOString(), requestId: work.task!.id };
    work = await repo.finish(work.id, work.task!.id, panel);
    assert.equal(work.task!.state, 'READY');
    assert.deepEqual(new Uint8Array(await work.panel!.blob.arrayBuffer()), new Uint8Array([1,4,9]));
    const sampleWork = await sample.save(newWork({ blob, width: 12, height: 8 }, blob));
    assert.equal(await repo.get(sampleWork.id), undefined);
    sample.close(); await resetMagnetSample();
    assert.ok(await repo.get(work.id));
    const next = await repo.begin(work, 'request-new', true);
    await repo.finish(next.id, 'request-new', { error: 'timeout', uncertain: true });
    assert.equal((await repo.get(next.id))!.task!.state, 'UNKNOWN');
    assert.ok((await repo.get(next.id))!.panel, 'previous successful panel survives a later timeout');
  } finally { repo.close(); other.close(); sample.close(); }
});
