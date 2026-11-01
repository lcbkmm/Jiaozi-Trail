import 'fake-indexeddb/auto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JiaoziRepository } from '../src/storage/repository.ts';
import { GIFTS } from '../src/config/rules.ts';
import { handleGameRequest } from '../src/game-api.ts';

const merchants = [{ id: 'chunxi-ifs', name: 'IFS 探索站', placeId: 'actual-ifs', landmarkId: 'landmark-01' }, { id: 'chunxi-taikoo', name: '太古里探索站', placeId: 'actual-taikoo' }];
const noRoute = async () => null;
async function fixture(t: TestContext) {
  const repo = await JiaoziRepository.open({ name: 'digital-jiaozi:game-api-test:' + crypto.randomUUID() }); t.after(() => repo.close());
  const app = {
    configureMerchants: repo.configureMerchants.bind(repo), getContext: repo.activeJourney.bind(repo), setRouteSnapshot: repo.setRouteSnapshot.bind(repo),
    demoCheckin: repo.demoCheckin.bind(repo), redeem: repo.redeem.bind(repo), cancelRedemption: (id: string) => repo.updateRedemption(id, 'cancel'), receiveDemoRedemption: (id: string) => repo.updateRedemption(id, 'receive'),
    getPlayerState: async () => ({ ...await repo.state(), gifts: GIFTS, sample: false, demo: true as const, merchants: repo.getMerchants(), activeJourney: await repo.activeJourney() })
  };
  return { repo, app };
}

test('地图初始化配置真实地点目录，命令与完整模块共用钱包、兑换和撤销记录', async t => {
  const { app } = await fixture(t);
  const initialized = await handleGameRequest(app, 'initialize', { merchants }, noRoute);
  assert.equal(initialized.wallet.balance, 0); assert.deepEqual(initialized.merchants, merchants); assert.equal(initialized.gifts.length, 5);
  const first = await handleGameRequest(app, 'demo-checkin', { merchantId: 'chunxi-ifs', eventId: 'first' }, noRoute);
  assert.ok('lastCheckin' in first); assert.equal(first.lastCheckin.awarded, 10); assert.equal(first.merchantCheckins.length, 1); assert.equal(first.claims.length, 0);
  await handleGameRequest(app, 'demo-checkin', { merchantId: 'chunxi-taikoo', eventId: 'second' }, noRoute);
  const spent = await handleGameRequest(app, 'redeem', { giftId: 'gift-charm', requestId: 'same-redemption' }, noRoute);
  assert.equal(spent.wallet.balance, 0); assert.equal(spent.redemptions.length, 1);
  const replay = await handleGameRequest(app, 'redeem', { giftId: 'gift-charm', requestId: 'same-redemption' }, noRoute);
  assert.equal(replay.redemptions.length, 1);
  const cancelled = await handleGameRequest(app, 'cancel-redemption', { id: spent.redemptions[0].id }, noRoute);
  assert.equal(cancelled.wallet.balance, 20); assert.equal(cancelled.wallet.earned, 20); assert.equal(cancelled.redemptions[0].status, 'cancelled');
  const next = await handleGameRequest(app, 'redeem', { giftId: 'gift-charm', requestId: 'next-redemption' }, noRoute);
  const order = next.redemptions.find(r => r.requestId === 'next-redemption')!;
  const received = await handleGameRequest(app, 'receive-demo-redemption', { id: order.id }, noRoute);
  assert.equal(received.redemptions.find(r => r.id === order.id)!.status, 'received');
  await assert.rejects(handleGameRequest(app, 'cancel-redemption', { id: order.id }, noRoute), { code: 'ORDER_FINAL' });
});

test('打卡只接受当前地图路线，正确路线快照写回同一进行中旅程', async t => {
  const { app, repo } = await fixture(t);
  await handleGameRequest(app, 'initialize', { merchants }, noRoute);
  const route = { id: 'map-route', title: '春熙路步行探索', source: 'demo' as const, places: [{ id: 'actual-ifs', name: '成都 IFS' }] };
  const input = { merchantId: 'chunxi-ifs', routeId: 'wrong-route', eventId: 'route-event' };
  await assert.rejects(handleGameRequest(app, 'demo-checkin', input, async () => route), /当前路线与打卡路线不一致/);
  assert.equal((await repo.state()).wallet.balance, 0); assert.equal((await repo.activeJourney()).route, null);
  const result = await handleGameRequest(app, 'demo-checkin', { ...input, routeId: route.id }, async () => route);
  assert.equal(result.wallet.balance, 10); assert.deepEqual((await repo.activeJourney()).route, route);
  assert.equal(result.merchantCheckins[0].routeId, route.id);
});

test('桥接不能声明正式核验、绕过目录或指定奖励；失败不增加余额', async t => {
  const { app } = await fixture(t);
  await handleGameRequest(app, 'initialize', { merchants }, noRoute);
  await assert.rejects(handleGameRequest(app, 'demo-checkin', { merchantId: 'chunxi-ifs', source: 'host' }, noRoute), /正式商家核验尚未接入/);
  await assert.rejects(handleGameRequest(app, 'demo-checkin', { merchantId: 'fabricated', amount: 999 }, noRoute), { code: 'UNKNOWN_MERCHANT' });
  await assert.rejects(handleGameRequest(app, 'accept-checkin', { merchantId: 'chunxi-ifs' }, noRoute), /不支持/);
  assert.equal((await handleGameRequest(app, 'get-player-state', {}, noRoute)).wallet.balance, 0);
  const state = await handleGameRequest(app, 'demo-checkin', { merchantId: 'chunxi-ifs', amount: 999, placeName: '冒充商家' }, noRoute);
  assert.equal(state.wallet.balance, 10); assert.equal(state.merchantCheckins[0].placeName, merchants[0].name);
});
