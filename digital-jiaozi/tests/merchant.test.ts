import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JiaoziRepository, request } from '../src/storage/repository.ts';
import { ACTIVITY } from '../src/config/rules.ts';
import { LANDMARKS } from '../src/config/landmarks.ts';
import type { MerchantCheckinInput } from '../src/domain/types.ts';

const merchants = [
  { id: 'chunxi-ifs', name: 'IFS 探索站', placeId: 'actual-ifs', landmarkId: 'landmark-01' },
  { id: 'chunxi-taikoo', name: '太古里探索站', placeId: 'actual-taikoo', landmarkId: 'landmark-02' },
  { id: 'chunxi-food', name: '商圈餐饮体验站', placeId: 'actual-food' }
];
async function open(t: TestContext, name = 'digital-jiaozi:merchant-test:' + crypto.randomUUID(), extra = {}) {
  const repo = await JiaoziRepository.open({ name, merchants, ...extra }); t.after(() => repo.close()); return repo;
}
async function event(repo: JiaoziRepository, merchantId = merchants[0].id): Promise<MerchantCheckinInput> {
  return { merchantId, journeyId: (await repo.activeJourney()).id, eventId: crypto.randomUUID(), source: 'demo' };
}

test('商家试玩多连接并发每日只奖励一次，事件冲突不产生收藏或第二条流水', async t => {
  const a = await open(t), b = await open(t, a.name), input = await event(a);
  const results = await Promise.all([a.demoCheckin(input), b.demoCheckin(input), a.demoCheckin({ ...input, eventId: crypto.randomUUID() }), b.demoCheckin({ ...input, eventId: crypto.randomUUID() })]);
  assert.equal(results.reduce((sum, r) => sum + r.awarded, 0), 10);
  const state = await b.state();
  assert.deepEqual(state.wallet, { activityId: ACTIVITY.id, earned: 10, balance: 10 });
  assert.equal(state.merchantCheckins.length, 1); assert.equal(state.claims.length, 0); assert.equal(state.ledger.length, 1);
  assert.equal(state.merchantCheckins[0].placeName, merchants[0].name);
  assert.equal(state.merchantCheckins[0].source, 'demo');
  assert.deepEqual((await a.activeJourney()).claimIds, []);
  await assert.rejects(b.demoCheckin({ ...input, merchantId: merchants[1].id }), { code: 'EVENT_CONFLICT' });
  assert.equal((await a.state()).wallet.balance, 10);
});

test('按上海时区换日重新奖励；重放旧事件不跨天重发，多个商家独立记账', async t => {
  let date = new Date('2026-10-31T15:59:59.000Z');
  const repo = await open(t, undefined, { clock: () => date }), input = await event(repo);
  const first = await repo.demoCheckin(input); assert.equal(first.checkin.day, '2026-10-31');
  date = new Date('2026-10-31T16:00:00.000Z');
  const replay = await repo.demoCheckin(input); assert.equal(replay.awarded, 0); assert.equal(replay.checkin.id, first.checkin.id);
  const nextDay = await repo.demoCheckin({ ...input, eventId: crypto.randomUUID() });
  assert.equal(nextDay.checkin.day, '2026-11-01'); assert.equal(nextDay.awarded, 10);
  await repo.demoCheckin(await event(repo, merchants[2].id));
  assert.equal((await repo.state()).wallet.balance, 30);
  const reopened = await open(t, repo.name, { clock: () => date });
  assert.equal((await reopened.demoCheckin(await event(reopened))).awarded, 0);
  assert.equal((await reopened.state()).merchantCheckins.length, 3);
});

test('正式来源、未知商家、只读快照与路线不匹配均不能发币', async t => {
  const repo = await open(t), input = await event(repo);
  await assert.rejects(repo.demoCheckin({ ...input, source: 'host' as 'demo' }), { code: 'VERIFICATION_UNAVAILABLE' });
  await assert.rejects(repo.demoCheckin({ ...input, merchantId: 'not-configured' }), { code: 'UNKNOWN_MERCHANT' });
  await assert.rejects(repo.demoCheckin({ ...input, journeyId: 'missing' }), { code: 'JOURNEY_NOT_FOUND' });
  await assert.rejects(repo.demoCheckin({ ...input, routeId: 'wrong-route' }), { code: 'ROUTE_MISMATCH' });
  const snapshot = await repo.saveJourney(input.journeyId, '已保存旅程');
  await assert.rejects(repo.demoCheckin({ ...input, journeyId: snapshot.id }), { code: 'SNAPSHOT_READONLY' });
  assert.equal((await repo.state()).wallet.balance, 0); assert.equal((await repo.state()).merchantCheckins.length, 0);
  assert.throws(() => repo.configureMerchants([...merchants, merchants[0]]));
  assert.throws(() => repo.configureMerchants([{ id: 'bad', name: 'x', landmarkId: 'unknown' }]));
});

test('商家交子与六景收藏共用钱包，商家收入不占六景上限且不自动多发收藏奖励', async t => {
  const repo = await open(t), journey = await repo.activeJourney();
  for (const merchant of merchants) await repo.demoCheckin(await event(repo, merchant.id));
  assert.equal((await repo.state()).claims.length, 0);
  for (const landmark of LANDMARKS) await repo.visit({ eventId: crypto.randomUUID(), activityId: ACTIVITY.id, landmarkId: landmark.id, journeyId: journey.id, occurredAt: new Date().toISOString(), source: 'demo' });
  let state = await repo.state();
  assert.equal(state.wallet.earned, 90); assert.equal(state.wallet.balance, 90); assert.equal(state.claims.length, 6);
  const order = await repo.redeem('gift-charm', 'shared-wallet-redemption');
  assert.equal((await repo.state()).wallet.balance, 70);
  const b = await open(t, repo.name);
  await Promise.all([repo.updateRedemption(order.id, 'cancel'), b.updateRedemption(order.id, 'cancel')]);
  state = await b.state(); assert.equal(state.wallet.balance, 90); assert.equal(state.wallet.earned, 90);
  assert.equal(state.ledger.filter(l => l.kind === 'refund').length, 1); assert.equal(state.claims.length, 6);
});

test('商家打卡写入中途失败整笔回滚，同一事件可以安全重试', async t => {
  const repo = await open(t), input = await event(repo), add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(...args: Parameters<typeof add>) {
    if (this.name === 'ledger') throw new DOMException('测试：存储空间不足', 'QuotaExceededError');
    return add.apply(this, args);
  };
  try { await assert.rejects(repo.demoCheckin(input), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.add = add; }
  let state = await repo.state(); assert.equal(state.wallet.balance, 0); assert.equal(state.merchantCheckins.length, 0); assert.equal(state.ledger.length, 0);
  assert.equal((await repo.demoCheckin(input)).awarded, 10);
  state = await repo.state(); assert.equal(state.wallet.balance, 10); assert.equal(state.merchantCheckins.length, 1);
});

test('仅有商家收入也能兑换；多连接花最后20交子不能透支', async t => {
  const a = await open(t), b = await open(t, a.name);
  await a.demoCheckin(await event(a)); await a.demoCheckin(await event(a, merchants[1].id));
  const results = await Promise.allSettled([a.redeem('gift-charm', crypto.randomUUID()), b.redeem('gift-charm', crypto.randomUUID())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const state = await a.state(); assert.equal(state.wallet.balance, 0); assert.equal(state.wallet.earned, 20); assert.equal(state.claims.length, 0);
});

test('v1档案升级只增加商家表，保留钱包准确金额、旧旅程、收藏、流水与照片Blob', async t => {
  const name = 'digital-jiaozi:migration-test:' + crypto.randomUUID();
  const req = indexedDB.open(name, 1);
  req.onupgradeneeded = () => {
    for (const store of ['meta', 'wallets', 'journeys', 'claims', 'ledger', 'redemptions', 'media', 'photos', 'events', 'tags', 'archives']) req.result.createObjectStore(store, { keyPath: store === 'wallets' ? 'activityId' : 'id' });
    req.transaction!.objectStore('claims').createIndex('activity-landmark', ['activityId', 'landmarkId'], { unique: true });
    req.transaction!.objectStore('redemptions').createIndex('request', 'requestId', { unique: true });
  };
  const db = await request(req), at = '2026-10-31T08:00:00.000Z';
  const tx = db.transaction([...db.objectStoreNames], 'readwrite');
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  tx.objectStore('meta').add({ id: 'profile', profileId: 'old-profile', schema: 1, createdAt: at });
  tx.objectStore('meta').add({ id: 'activeJourney', value: 'old-journey' });
  tx.objectStore('wallets').add({ activityId: ACTIVITY.id, earned: 10, balance: 7 });
  tx.objectStore('journeys').add({ id: 'old-journey', activityId: ACTIVITY.id, title: '旧旅程', createdAt: at, route: null, claimIds: ['old-claim'], photoIds: ['old-photo'] });
  tx.objectStore('claims').add({ id: 'old-claim', activityId: ACTIVITY.id, landmarkId: LANDMARKS[0].id, journeyId: 'old-journey', eventId: 'old-event', source: 'demo', order: 1, occurredAt: at, receivedAt: at, place: { ...LANDMARKS[0], landmarkId: LANDMARKS[0].id } });
  tx.objectStore('ledger').add({ id: 'old-ledger', activityId: ACTIVITY.id, kind: 'earn', amount: 10, title: '旧收入', reference: 'old-claim', createdAt: at });
  const blob = new Blob(['original-photo-bytes'], { type: 'image/png' });
  tx.objectStore('media').add({ id: 'old-media', blob, createdAt: at });
  tx.objectStore('photos').add({ id: 'old-photo', journeyId: 'old-journey', mediaId: 'old-media', title: '保留原照', mode: 'color', createdAt: at });
  await done; db.close();
  const repo = await open(t, name), state = await repo.state();
  assert.equal(state.profile.id, 'old-profile'); assert.equal(state.wallet.balance, 7); assert.equal(state.wallet.earned, 10);
  assert.equal(state.claims[0].id, 'old-claim'); assert.equal(state.ledger[0].id, 'old-ledger'); assert.equal(state.photos[0].id, 'old-photo');
  assert.equal((await repo.activeJourney()).id, 'old-journey'); assert.deepEqual(state.merchantCheckins, []);
  assert.deepEqual(await (await repo.media('old-media'))!.arrayBuffer(), await blob.arrayBuffer());
  await repo.demoCheckin(await event(repo)); assert.equal((await repo.state()).wallet.balance, 17);
});

test('独立示例的钱包和商家奖励不写入个人档案', async t => {
  const personal = await open(t), sample = await open(t);
  await sample.demoCheckin(await event(sample));
  assert.equal((await sample.state()).wallet.balance, 10); assert.equal((await personal.state()).wallet.balance, 0);
});
