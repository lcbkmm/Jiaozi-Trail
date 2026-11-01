// Browser-only contract fixture. Never included in either production entry.
import { mountDigitalJiaozi } from '/module/digital-jiaozi.js';
const activityId = 'six-landmarks-2026-v1';
const enabled = new URLSearchParams(location.search).has('rewards');
window.rewardCalls = []; window.failRedeem = false; window.failLoad = false; window.failCancel = false;
let account = { wallet: { activityId, earned: 60, balance: 60 }, availableGiftIds: ['gift-charm'], orders: [] };
if (new URLSearchParams(location.search).has('merchantCredits')) account.wallet = { activityId, earned: 90, balance: 90 };
const copy = () => structuredClone(account);
const rewards = {
  load: async () => { if (window.failLoad) throw Error('fixture unavailable'); return copy(); },
  redeem: async ({ giftId, requestId }) => {
    window.rewardCalls.push(requestId);
    if (!account.orders.some(o => o.requestId === requestId)) {
      account.wallet.balance -= 20;
      account.orders.unshift({ id: 'order-' + requestId, activityId, giftId, requestId, title: '胸章 / 小挂件', cost: 20, status: 'pending', createdAt: new Date().toISOString(), receipt: '领取点 A · 凭证 1234' });
    }
    if (window.failRedeem) { window.failRedeem = false; throw Error('fixture lost response'); }
    return copy();
  },
  cancel: async ({ orderId }) => {
    if (window.failCancel) throw Error('fixture unavailable');
    const o = account.orders.find(o => o.id === orderId);
    if (o?.status === 'pending') { o.status = 'cancelled'; account.wallet.balance += o.cost; }
    return copy();
  }
};
window.dj = await mountDigitalJiaozi(document.getElementById('mount'), {
  routing: 'memory', assetBase: '/preview/', publicBaseUrl: location.origin + '/preview/',
  adapters: {
    ...(enabled ? { rewards } : {}),
    navigateToCheckin: async landmark => {
      const journey = await window.dj.getContext();
      const input = { activityId, eventId: 'verified-' + landmark.id, landmarkId: landmark.id, journeyId: journey.id, occurredAt: '2026-11-01T06:00:00Z' };
      await window.dj.acceptCheckin(input); await window.dj.acceptCheckin(input);
    },
    getRouteSnapshot: async () => ({ id: 'trip-001', title: '成都慢游一天', source: 'host', places: [{ id: 'place-001', name: '成都 IFS' }] })
  }
});
window.ready = true;
