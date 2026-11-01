import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JiaoziRepository, resetSample, readLegacySettings } from '../src/storage/repository.ts';
import { ACTIVITY, PERSONAL_DB, SAMPLE_DB } from '../src/config/rules.ts';
import { LANDMARKS } from '../src/config/landmarks.ts';
import type { VisitInput } from '../src/domain/types.ts';

async function open(t: TestContext, name = 'digital-jiaozi:test:' + crypto.randomUUID(), extra = {}) {
  const repo = await JiaoziRepository.open({ name, ...extra }); t.after(() => repo.close()); return repo;
}
async function input(repo: JiaoziRepository, index = 0): Promise<VisitInput> {
  return { eventId: crypto.randomUUID(), activityId: ACTIVITY.id, landmarkId: LANDMARKS[index].id,
    journeyId: (await repo.activeJourney()).id, occurredAt: '2026-10-31T08:00:00.000Z', source: 'demo' };
}
async function collect(repo: JiaoziRepository, count = 6) { for (let i = 0; i < count; i++) await repo.visit(await input(repo, i)); }

test('初始 0 分，首次打卡三项原子入账，另一个连接与重开恢复', async t => {
  const repo = await open(t), event = await input(repo);
  assert.equal((await repo.state()).wallet.balance, 0);
  const result = await repo.visit(event); assert.equal(result.awarded, 10);
  const same = await open(t, repo.name), state = await same.state();
  assert.deepEqual(state.wallet, { activityId: ACTIVITY.id, earned: 10, balance: 10 });
  assert.equal(state.claims.length, 1); assert.equal(state.ledger.length, 1);
  assert.deepEqual((await same.activeJourney()).claimIds, [result.claim.id]);
  same.close(); const reopened = await open(t, repo.name);
  assert.equal((await reopened.state()).claims.length, 1);
});

test('相同事件、换 eventId、不同连接并发均只奖励一次；冲突事件明确拒绝', async t => {
  const a = await open(t), b = await open(t, a.name), event = await input(a);
  const results = await Promise.all([a.visit(event), b.visit(event), a.visit({ ...event, eventId: crypto.randomUUID() }), b.visit({ ...event, eventId: crypto.randomUUID() })]);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal((await a.state()).wallet.earned, 10);
  await assert.rejects(a.visit({ ...event, landmarkId: 'landmark-02' }), { code: 'EVENT_CONFLICT' });
  assert.equal((await a.state()).ledger.length, 1);
});

test('六款 60 分；兑换 20 后余 40，累计与收藏不变；请求幂等、余额不足无写入', async t => {
  const repo = await open(t); await collect(repo);
  const requestId = crypto.randomUUID(), first = await repo.redeem('gift-charm', requestId);
  assert.equal((await repo.redeem('gift-charm', requestId)).id, first.id);
  await assert.rejects(repo.redeem('gift-nfc', crypto.randomUUID()), { code: 'INSUFFICIENT_POINTS' });
  await assert.rejects(repo.redeem('gift-magnet', requestId), { code: 'REQUEST_CONFLICT' });
  const state = await repo.state();
  assert.deepEqual(state.wallet, { activityId: ACTIVITY.id, earned: 60, balance: 40 });
  assert.equal(state.claims.length, 6); assert.equal(state.redemptions.length, 1);
  assert.equal((await repo.activeJourney()).claimIds.length, 6);
});

test('并发取消只退款一次，累计不增加；领取后不能退款', async t => {
  const a = await open(t), b = await open(t, a.name); await collect(a);
  const order = await a.redeem('gift-charm', crypto.randomUUID());
  await Promise.all([a.updateRedemption(order.id, 'cancel'), b.updateRedemption(order.id, 'cancel')]);
  assert.deepEqual((await a.state()).wallet, { activityId: ACTIVITY.id, earned: 60, balance: 60 });
  assert.equal((await a.state()).ledger.filter(l => l.kind === 'refund').length, 1);
  const next = await a.redeem('gift-charm', crypto.randomUUID());
  await a.updateRedemption(next.id, 'receive');
  await assert.rejects(b.updateRedemption(next.id, 'cancel'), { code: 'ORDER_FINAL' });
  assert.equal((await a.state()).wallet.balance, 40);
});

test('多连接同时花最后 40 分只能成功一次，不产生负余额', async t => {
  const a = await open(t), b = await open(t, a.name); await collect(a, 4);
  const results = await Promise.allSettled([a.redeem('gift-keepsake', crypto.randomUUID()), b.redeem('gift-keepsake', crypto.randomUUID())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await a.state()).wallet.balance, 0);
  assert.equal((await a.state()).redemptions.length, 1);
});

test('独立场景兑换 60 分 NFC 后为 0，旅程快照和六张票保留', async t => {
  const repo = await open(t); await collect(repo);
  const journey = await repo.activeJourney(); const saved = await repo.saveJourney(journey.id, '六景旅程');
  await repo.redeem('gift-nfc', crypto.randomUUID());
  assert.equal((await repo.state()).wallet.balance, 0);
  assert.equal((await repo.findJourney({ journeyId: saved.id }))!.snapshot!.claims.length, 6);
});

test('故障发生在钱包写入之后也回滚领取、订单、流水全部内容', async t => {
  const repo = await open(t), event = await input(repo);
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(...args: Parameters<typeof add>) {
    if (this.name === 'ledger') throw new DOMException('测试：存储空间不足', 'QuotaExceededError');
    return add.apply(this, args);
  };
  try { await assert.rejects(repo.visit(event), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.add = add; }
  let state = await repo.state();
  assert.equal(state.wallet.balance, 0); assert.equal(state.claims.length, 0);
  assert.equal((await repo.activeJourney()).claimIds.length, 0);
  await collect(repo, 2);
  IDBObjectStore.prototype.add = function(...args: Parameters<typeof add>) {
    if (this.name === 'ledger') throw new DOMException('测试：存储空间不足', 'QuotaExceededError');
    return add.apply(this, args);
  };
  try { await assert.rejects(repo.redeem('gift-charm', crypto.randomUUID())); }
  finally { IDBObjectStore.prototype.add = add; }
  state = await repo.state(); assert.equal(state.wallet.balance, 20); assert.equal(state.redemptions.length, 0);
});

test('照片保存真实 Blob，重开保留原字节，失败与重试不会产生孤立媒体', async t => {
  const repo = await open(t), journey = await repo.activeJourney();
  const blob = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
  const data = { journeyId: journey.id, blob, title: '自己的照片', mode: 'color' as const, requestId: crypto.randomUUID() };
  const photo = await repo.addPhoto(data); assert.equal((await repo.addPhoto(data)).id, photo.id);
  const reopened = await open(t, repo.name);
  assert.deepEqual(await (await reopened.media(photo.mediaId))!.arrayBuffer(), await blob.arrayBuffer());
  await assert.rejects(repo.addPhoto({ ...data, journeyId: 'missing', requestId: crypto.randomUUID() }));
  assert.equal((await repo.state()).photos.length, 1); assert.equal((await repo.state()).wallet.balance, 0);
});

test('保存时复制路线、地点和照片快照，后续打卡不改变它；未知指定记录不冒充其他旅程', async t => {
  const repo = await open(t), journey = await repo.activeJourney(); await collect(repo, 1);
  const route = { id: 'route-1', title: '宿主路线', source: 'host' as const, places: [{ id: 'place-1', name: '保存时的名称' }] };
  const firstSave = await repo.saveJourney(journey.id, '我的旅程', route); route.places[0].name = '后来的名称';
  await repo.visit(await input(repo, 1)); await repo.bindTag('tag-1', firstSave.id);
  const saved = (await repo.findJourney({ tagId: 'tag-1' }))!;
  assert.equal(saved.snapshot!.claims.length, 1);
  assert.equal(saved.snapshot!.route!.places[0].name, '保存时的名称');
  assert.equal((await repo.findJourney({}))!.id, firstSave.id);
  const secondSave = await repo.saveJourney(journey.id, '第二次保存');
  assert.notEqual(firstSave.id, secondSave.id);
  assert.equal((await repo.findJourney({ journeyId: firstSave.id }))!.snapshot!.claims.length, 1);
  assert.equal((await repo.findJourney({ journeyId: secondSave.id }))!.snapshot!.claims.length, 2);
  await assert.rejects(repo.bindTag('tag-1', secondSave.id), { code: 'TAG_CONFLICT' });
  assert.equal(await repo.findJourney({ journeyId: 'missing' }), null);
  assert.equal(await repo.findJourney({ tagId: 'missing' }), null);
  assert.equal(await repo.findJourney({ tagId: 'tag-1', journeyId: 'missing' }), null);
});

test('manifest 可替换当前收藏图片，已保存纪念快照保持原记录', async t => {
  const repo = await open(t); await collect(repo, 1); const journey = await repo.activeJourney();
  await repo.saveJourney(journey.id, '原记录');
  const landmarks = LANDMARKS.map(l => ({ ...l, image: 'assets/new.webp', placeholder: false }));
  const next = await open(t, repo.name, { landmarks });
  assert.equal((await next.state()).claims[0].place.image, 'assets/new.webp');
  assert.equal((await next.findJourney({}))!.snapshot!.claims[0].place.image, LANDMARKS[0].image);
  await next.saveJourney(journey.id, '主动更新快照');
  assert.equal((await next.findJourney({}))!.snapshot!.claims[0].place.image, 'assets/new.webp');
});

test('旧设置备份、旧积分不迁移；个人与示例独立，重置示例不删个人照片', async t => {
  const items = new Map([['dj:points', '600'], ['team:token', 'do-not-copy']]);
  const legacy = readLegacySettings({ length: 2, key: (i: number) => [...items.keys()][i], getItem: (k: string) => items.get(k) } as Storage);
  assert.deepEqual(legacy, { 'dj:points': '600' });
  const personal = await open(t, PERSONAL_DB, { legacy }); const sample = await open(t, SAMPLE_DB);
  assert.equal((await personal.state()).wallet.balance, 0); assert.equal((await personal.legacyArchive()).length, 1);
  await personal.addPhoto({ journeyId: (await personal.activeJourney()).id, title: '保留', mode: 'color', blob: new Blob(['photo'], { type: 'image/png' }), requestId: crypto.randomUUID() });
  await collect(sample, 2); sample.close(); await resetSample();
  assert.equal((await personal.state()).photos.length, 1);
  assert.equal((await personal.state()).wallet.balance, 0);
  assert.equal((await (await open(t, SAMPLE_DB)).state()).claims.length, 0);
  assert.equal(items.get('dj:points'), '600');
});

test('未知地标、活动或冲突 placeId 被拒绝，宿主目录映射可用', async t => {
  const repo = await open(t, undefined, { landmarks: LANDMARKS.map(l => ({ ...l, placeId: 'host-' + l.id })) });
  const event = await input(repo);
  await assert.rejects(repo.visit({ ...event, activityId: 'old' }), { code: 'ACTIVITY_MISMATCH' });
  await assert.rejects(repo.visit({ ...event, landmarkId: 'unknown' }), { code: 'UNKNOWN_LANDMARK' });
  await assert.rejects(repo.visit({ ...event, placeId: 'wrong' }));
  assert.equal((await repo.visit({ ...event, landmarkId: undefined, placeId: 'host-landmark-01', source: 'host' })).awarded, 10);
  await repo.setRouteSnapshot(event.journeyId, { id: 'host-route', title: '宿主路线', source: 'host', places: [{id:'host-landmark-02',name:'宿主地点'}] });
  await assert.rejects(repo.visit({ ...await input(repo,1), routeId: 'wrong' }), { code:'ROUTE_MISMATCH' });
  assert.equal((await repo.visit({ ...await input(repo,1), routeId:'host-route' })).awarded,10);
});
