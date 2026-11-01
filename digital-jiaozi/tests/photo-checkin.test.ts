import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { JiaoziRepository } from '../src/storage/repository.ts';
import { visitorState } from '../src/domain/visitor.ts';
import { ACTIVITY } from '../src/config/rules.ts';

async function photo() {
  const buffer = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#6c907a' } }).png().toBuffer();
  return new Blob([new Uint8Array(buffer)], { type: 'image/png' });
}

test('照片、地标、积分原子入账，多连接和重试不重复；快照与重开保留照片', async t => {
  const name = 'photo:' + crypto.randomUUID(), a = await JiaoziRepository.open({ name }), b = await JiaoziRepository.open({ name });
  t.after(() => { a.close(); b.close(); });
  const journey = await a.activeJourney(), blob = await photo();
  const input = { eventId: 'photo-1', landmarkId: 'landmark-01', journeyId: journey.id, blob };
  const results = await Promise.all([a.photoCheckin(input), b.photoCheckin(input), b.photoCheckin({ ...input, eventId: 'photo-2' })]);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  const first = results[0].claim;
  assert.equal(first.source, 'photo'); assert.ok(first.checkinMediaId);
  assert.deepEqual(await (await b.media(first.checkinMediaId))!.arrayBuffer(), await blob.arrayBuffer());
  await assert.rejects(a.photoCheckin({ ...input, landmarkId: 'landmark-02' }), { code: 'EVENT_CONFLICT' });
  const fromHost = await a.visit({ eventId: 'host-same', activityId: ACTIVITY.id, landmarkId: 'landmark-01', journeyId: journey.id, occurredAt: new Date().toISOString(), source: 'host' });
  assert.equal(fromHost.awarded, 0); assert.equal(fromHost.claim.source, 'photo');
  const saved = await a.saveJourney(journey.id, '照片打卡旅程', null, false);
  assert.equal(saved.snapshot!.claims.length, 1); assert.equal(saved.snapshot!.claims[0].checkinMediaId, first.checkinMediaId);
  for (let i = 2; i <= 6; i++) await a.photoCheckin({ ...input, eventId: 'landmark-' + i, landmarkId: 'landmark-0' + i });
  const reopened = await JiaoziRepository.open({ name }); t.after(() => reopened.close());
  const visitor = visitorState(await reopened.state());
  assert.deepEqual(visitor.wallet, { activityId: ACTIVITY.id, earned: 60, balance: 60 });
  assert.equal(visitor.claims.length, 6); assert.equal(visitor.ledger.length, 6); assert.equal(visitor.photos.length, 0);
  assert.equal((await reopened.findJourney({ journeyId: saved.id }))!.snapshot!.claims.length, 1);
  assert.deepEqual(await (await reopened.media(first.checkinMediaId))!.arrayBuffer(), await blob.arrayBuffer());
});

test('空照片、错误格式、超限、未知地标不发奖；旧演示来源原样保留', async t => {
  const repo = await JiaoziRepository.open({ name: 'photo:' + crypto.randomUUID() }); t.after(() => repo.close());
  const input = { eventId: 'photo-1', landmarkId: 'landmark-01', journeyId: (await repo.activeJourney()).id, blob: await photo() };
  await assert.rejects(repo.photoCheckin({ ...input, blob: new Blob([]) }), { code: 'IMAGE_EMPTY' });
  await assert.rejects(repo.photoCheckin({ ...input, blob: new Blob(['not a photo'], { type: 'image/jpeg' }) }), { code: 'IMAGE_FORMAT' });
  await assert.rejects(repo.photoCheckin({ ...input, blob: new Blob([new Uint8Array(15 * 1024 * 1024 + 1)]) }), { code: 'IMAGE_SIZE' });
  await assert.rejects(repo.photoCheckin({ ...input, landmarkId: 'missing' }), { code: 'UNKNOWN_LANDMARK' });
  assert.equal((await repo.state()).wallet.balance, 0);
  await repo.visit({ ...input, activityId: ACTIVITY.id, occurredAt: new Date().toISOString(), source: 'demo' });
  await assert.rejects(repo.photoCheckin({ ...input, eventId: 'new-photo' }), { code: 'SOURCE_CONFLICT' });
  const raw = await repo.state();
  assert.equal(raw.wallet.balance, 10); assert.equal(raw.claims[0].source, 'demo'); assert.equal(visitorState(raw).wallet.balance, 0);
});

test('照片已写入后存储失败，照片、收藏、钱包、旅程及流水全部回滚，可原请求重试', async t => {
  const name = 'photo:' + crypto.randomUUID(), repo = await JiaoziRepository.open({ name }); t.after(() => repo.close());
  const input = { eventId: 'retry-photo', landmarkId: 'landmark-01', journeyId: (await repo.activeJourney()).id, blob: await photo() };
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(...args: Parameters<typeof add>) {
    if (this.name === 'ledger') throw new DOMException('空间不足', 'QuotaExceededError');
    return add.apply(this, args);
  };
  try { await assert.rejects(repo.photoCheckin(input), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.add = add; }
  const raw = await repo.state();
  assert.equal(raw.wallet.balance, 0); assert.equal(raw.claims.length, 0); assert.equal(raw.ledger.length, 0); assert.deepEqual((await repo.activeJourney()).claimIds, []);
  const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(name, 2); r.onsuccess = () => resolve(r.result); });
  const mediaCount = await new Promise<number>(resolve => { const r = db.transaction('media').objectStore('media').count(); r.onsuccess = () => resolve(r.result); });
  db.close(); assert.equal(mediaCount, 0);
  assert.equal((await repo.photoCheckin(input)).awarded, 10);
});
