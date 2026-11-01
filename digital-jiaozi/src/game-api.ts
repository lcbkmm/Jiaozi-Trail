import { newId } from './domain/id.ts';
import type { Merchant, RouteSnapshot } from './domain/types.ts';
import type { mountDigitalJiaozi } from './module.ts';

type App = Pick<Awaited<ReturnType<typeof mountDigitalJiaozi>>, 'configureMerchants' | 'getContext' | 'setRouteSnapshot' | 'demoCheckin' | 'getPlayerState' | 'redeem' | 'cancelRedemption' | 'receiveDemoRedemption'>;
type Payload = Record<string, unknown>;
// These commands always operate on the very same repository used by the full
// collectible/photograph/journey app. There is no second map wallet.
export async function handleGameRequest(app: App, action: string, data: unknown, getRoute: () => Promise<RouteSnapshot | null>) {
  const payload = data && typeof data === 'object' ? data as Payload : {};
  const id = (key: string) => {
    const value = payload[key];
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value)) throw new Error('请求编号不正确：' + key);
    return value;
  };
  if (action === 'initialize') {
    app.configureMerchants(payload.merchants as Merchant[]);
  } else if (action === 'get-player-state') {
    // Read-only synchronization also restores the current full app state.
  } else if (action === 'demo-checkin') {
    if (payload.source && payload.source !== 'demo') throw new Error('正式商家核验尚未接入，请使用试玩打卡。');
    const journeyId = payload.journeyId === undefined ? (await app.getContext()).id : id('journeyId');
    const routeId = payload.routeId === undefined ? undefined : id('routeId');
    if (routeId) {
      const route = await getRoute();
      if (!route || route.id !== routeId) throw new Error('地图当前路线与打卡路线不一致，请重新选择路线。');
      await app.setRouteSnapshot(journeyId, route);
    }
    const result = await app.demoCheckin({ merchantId: id('merchantId'), journeyId, routeId, eventId: payload.eventId === undefined ? newId() : id('eventId'), source: 'demo' });
    return { ...await app.getPlayerState(), lastCheckin: result };
  } else if (action === 'redeem') {
    await app.redeem(id('giftId'), id('requestId'));
  } else if (action === 'cancel-redemption') {
    await app.cancelRedemption(id('id'));
  } else if (action === 'receive-demo-redemption') {
    await app.receiveDemoRedemption(id('id'));
  } else throw new Error('不支持的交子操作。');
  return app.getPlayerState();
}
