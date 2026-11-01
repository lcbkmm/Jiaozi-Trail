import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const merchants = [{ id: 'chunxi-ifs', name: 'IFS 探索站', landmarkId: 'landmark-01' }, { id: 'chunxi-food', name: '商圈餐饮体验站' }];
async function openFrame(page: Page, demo: boolean) {
  await page.goto('/map-parent.html');
  await page.evaluate(demo => {
    const frame = document.createElement('iframe'); frame.id = 'jiaozi'; frame.style.cssText = 'width:375px;height:812px;border:0';
    const host = window as any;
    host.bridgeReady = false; host.bridgeCalls = []; host.sequence = 0; host.pending = new Map();
    host.command = (action: string, payload = {}) => new Promise(resolve => {
      const requestId = 'parent-' + ++host.sequence;
      host.pending.set(requestId, resolve);
      frame.contentWindow!.postMessage({ channel: 'jiaozi-map:v1', type: 'request', requestId, action, payload }, location.origin);
    });
    addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.channel !== 'jiaozi-map:v1') return;
      const message = event.data;
      if (message.type === 'ready') host.bridgeReady = true;
      if (message.type === 'response') { host.pending.get(message.requestId)?.(message); host.pending.delete(message.requestId); }
      if (message.type === 'close') host.bridgeCalls.push('close');
      if (message.type === 'request') {
        host.bridgeCalls.push(message.action);
        const result = message.action === 'get-route' ? { id: 'map-route', title: '试玩地图路线', source: 'demo', places: [] } : true;
        frame.contentWindow!.postMessage({ channel: 'jiaozi-map:v1', type: 'response', requestId: message.requestId, ok: true, result }, location.origin);
      }
    });
    frame.src = '/preview/' + (demo ? 'demo.html' : 'index.html') + '#/digital-jiaozi';
    document.body.append(frame);
  }, demo);
  await page.waitForFunction(() => (window as any).bridgeReady);
}
async function command(page: Page, action: string, payload = {}): Promise<any> {
  return page.evaluate(({ action, payload }) => (window as any).command(action, payload), { action, payload });
}

test('游客默认入口保留地图桥接与返回按钮，拒绝试玩写入及路线副作用', async ({ page }) => {
  await openFrame(page, false);
  const initialized = await command(page, 'initialize', { merchants });
  expect(initialized.ok).toBe(true); expect(initialized.result.demo).toBe(false); expect(initialized.result.sample).toBe(false);
  const refused = await command(page, 'demo-checkin', { merchantId: merchants[0].id, routeId: 'map-route', eventId: 'demo-attempt' });
  expect(refused.ok).toBe(false); expect(refused.error).toContain('独立开发演示');
  expect((await command(page, 'redeem', { giftId: 'gift-charm', requestId: 'demo-redemption' })).ok).toBe(false);
  const state = (await command(page, 'get-player-state')).result;
  expect(state.wallet.balance).toBe(0); expect(state.merchantCheckins).toEqual([]); expect(state.activeJourney.route).toBeNull();
  const frame = page.frameLocator('#jiaozi');
  await frame.locator('nav [data-id=collection]').click();
  await expect(frame.locator('[data-action=photo-checkin]').first()).toBeEnabled();
  await frame.locator('[data-action=photo-checkin]').first().click();
  await expect(frame.getByRole('dialog', { name: '照片打卡', exact: true })).toBeVisible();
  await frame.getByLabel('关闭弹窗').click();
  await frame.locator('[data-action=host-place]').first().click();
  await frame.locator('[data-action=return-map]').click();
  expect(await page.evaluate(() => (window as any).bridgeCalls)).toEqual(['navigate-place', 'close']);
});

test('队友商家试玩桥接每日去重、共用钱包兑换退回和刷新保留，游客个人库独立', async ({ page }) => {
  await openFrame(page, true);
  const initialized = (await command(page, 'initialize', { merchants })).result;
  expect(initialized.demo).toBe(true); expect(initialized.sample).toBe(true);
  const first = (await command(page, 'demo-checkin', { merchantId: merchants[0].id, eventId: 'first' })).result;
  expect(first.lastCheckin.awarded).toBe(10); expect(first.claims).toHaveLength(0);
  const duplicate = (await command(page, 'demo-checkin', { merchantId: merchants[0].id, eventId: 'second' })).result;
  expect(duplicate.lastCheckin.awarded).toBe(0); expect(duplicate.wallet.balance).toBe(10);
  expect((await command(page, 'demo-checkin', { merchantId: merchants[1].id })).result.wallet.balance).toBe(20);
  const order = (await command(page, 'redeem', { giftId: 'gift-charm', requestId: 'order-1' })).result;
  expect(order.wallet.balance).toBe(0); expect(order.redemptions).toHaveLength(1);
  expect((await command(page, 'cancel-redemption', { id: order.redemptions[0].id })).result.wallet.balance).toBe(20);
  await page.evaluate(() => { (window as any).bridgeReady = false; (document.getElementById('jiaozi') as HTMLIFrameElement).contentWindow!.location.reload(); });
  await page.waitForFunction(() => (window as any).bridgeReady);
  const restored = (await command(page, 'get-player-state')).result;
  expect(restored.wallet.balance).toBe(20); expect(restored.merchantCheckins).toHaveLength(2);
  await command(page, 'initialize', { merchants });
  const frame = page.frameLocator('#jiaozi'); await frame.locator('nav [data-id=collection]').click();
  await expect(frame.getByRole('heading', { name: '商家打卡试玩' })).toBeVisible();
  await frame.locator('[data-action=merchant-demo]').first().click();
  await expect(frame.locator('.dj-toast')).toContainText('不重复发放');
  await openFrame(page, false);
  const visitor = (await command(page, 'get-player-state')).result;
  expect(visitor.wallet.balance).toBe(0); expect(visitor.merchantCheckins).toEqual([]);
});

test('活动方已核验的商家积分可超过六景60分，正常展示和兑换', async ({ page }) => {
  await page.goto('/visitor-host.html?rewards=1&merchantCredits=1');
  await page.waitForFunction(() => (window as any).ready);
  await page.locator('nav [data-id=rewards]').click();
  await expect(page.getByTestId('balance')).toHaveText('90');
  await page.locator('[data-action=redeem]').first().click();
  await page.locator('[data-action=confirm-redeem]').click();
  await expect(page.getByTestId('balance')).toHaveText('70');
  await expect(page.locator('.dj-order')).toHaveCount(1);
  const codes = await page.evaluate(async () => {
    const app = (window as any).dj, errors: string[] = [];
    for (const run of [() => app.demoCheckin({}), () => app.redeem('gift-charm', 'x'), () => app.cancelRedemption('x'), () => app.receiveDemoRedemption('x')]) {
      try { await run(); } catch (e) { errors.push((e as any).code); }
    }
    return errors;
  });
  expect(codes).toEqual(Array(4).fill('DEMO_DISABLED'));
});
