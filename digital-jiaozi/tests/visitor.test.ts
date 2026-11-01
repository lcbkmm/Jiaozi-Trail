import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JiaoziRepository } from '../src/storage/repository.ts';
import { visitorState, validateRewardAccount } from '../src/domain/visitor.ts';
import { ACTIVITY } from '../src/config/rules.ts';

test('历史演示无损保留，游客投影与新快照排除演示；真实同地标回调不冒充领取', async t => {
  const repo = await JiaoziRepository.open({ name: 'visitor:' + crypto.randomUUID() }); t.after(() => repo.close());
  const journey = await repo.activeJourney();
  const input = { activityId: ACTIVITY.id, journeyId: journey.id, occurredAt: new Date().toISOString() };
  await repo.visit({ ...input, eventId: 'demo-1', landmarkId: 'landmark-01', source: 'demo' });
  await repo.visit({ ...input, eventId: 'host-2', landmarkId: 'landmark-02', source: 'host' });
  const old = await repo.saveJourney(journey.id, '旧纪念', { id: 'demo-route', title: '模拟路线', source: 'demo', places: [] });
  const raw = await repo.state(), projected = visitorState(raw);
  assert.equal(raw.wallet.balance, 20); assert.equal(projected.wallet.balance, 10);
  assert.deepEqual(projected.claims.map(c => c.landmarkId), ['landmark-02']);
  await assert.rejects(repo.visit({ ...input, eventId: 'host-1', landmarkId: 'landmark-01', source: 'host' }), { code: 'SOURCE_CONFLICT' });
  const saved = await repo.saveJourney(journey.id, '游客纪念', undefined, false);
  assert.equal(saved.snapshot!.claims.length, 1); assert.equal(saved.snapshot!.route, null);
  assert.deepEqual((await repo.findJourney({ journeyId: old.id }))?.snapshot, old.snapshot);
  assert.equal((await repo.state()).claims.length, 2); assert.equal((await repo.state()).wallet.balance, 20);
});

test('兑换意图跨连接与刷新复用，错误确认不会删除未完成请求', async t => {
  const name = 'visitor:' + crypto.randomUUID();
  const a = await JiaoziRepository.open({ name }), b = await JiaoziRepository.open({ name }); t.after(() => { a.close(); b.close(); });
  const ids = await Promise.all([a.rewardRequest('gift-charm'), b.rewardRequest('gift-charm')]);
  assert.equal(ids[0], ids[1]);
  await a.finishRewardRequest('gift-charm', 'wrong-id'); assert.equal(await b.rewardRequest('gift-charm'), ids[0]);
  await a.finishRewardRequest('gift-charm', ids[0]); assert.notEqual(await b.rewardRequest('gift-charm'), ids[0]);
});

test('活动响应必须包含匹配活动、合法余额、礼品与订单状态', () => {
  const good = { wallet: { activityId: ACTIVITY.id, earned: 60, balance: 40 }, availableGiftIds: ['gift-charm'], orders: [] };
  assert.deepEqual(validateRewardAccount(good), good);
  assert.equal(validateRewardAccount({ ...good, wallet: { ...good.wallet, earned: 90, balance: 70 } }).wallet.balance, 70);
  assert.throws(() => validateRewardAccount({ ...good, wallet: { ...good.wallet, earned: Number.MAX_SAFE_INTEGER + 1 } }));
  assert.throws(() => validateRewardAccount({ ...good, wallet: { ...good.wallet, balance: 100 } }));
  assert.throws(() => validateRewardAccount({ ...good, availableGiftIds: ['fake'] }));
  assert.throws(() => validateRewardAccount({ ...good, orders: [{ id: 'a', activityId: ACTIVITY.id, requestId: 'b', giftId: 'gift-charm', title: '胸章', cost: 1, status: 'pending', createdAt: new Date().toISOString() }] }));
});

test('队友v2商家试玩记录原样保留，不能变成游客消费收入或占用地标奖励', async t => {
  const name = 'visitor:' + crypto.randomUUID();
  const repo = await JiaoziRepository.open({ name, merchants: [{ id: 'merchant-a', name: '体验站 A' }] });
  t.after(() => repo.close());
  const journey = await repo.activeJourney();
  await repo.demoCheckin({ eventId: 'merchant-demo', merchantId: 'merchant-a', journeyId: journey.id, source: 'demo' });
  await repo.visit({ eventId: 'host-visit', activityId: ACTIVITY.id, landmarkId: 'landmark-01', journeyId: journey.id, occurredAt: new Date().toISOString(), source: 'host' });
  const reopened = await JiaoziRepository.open({ name }); t.after(() => reopened.close());
  const raw = await reopened.state(), visitor = visitorState(raw);
  assert.equal(raw.merchantCheckins.length, 1); assert.equal(raw.wallet.balance, 20);
  assert.equal(visitor.merchantCheckins.length, 0); assert.equal(visitor.wallet.balance, 10);
  assert.equal(visitor.ledger.length, 1); assert.equal(visitor.claims.length, 1);
  assert.equal((await reopened.state()).merchantCheckins[0].eventId, 'merchant-demo');
});
