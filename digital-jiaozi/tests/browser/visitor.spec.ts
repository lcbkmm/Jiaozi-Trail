import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
const home = '/preview/#/digital-jiaozi';
const nav = (page: Page, id: string) => page.locator(`nav [data-id=${id}]`).click();
async function inject(page: Page, action: string, id = 'landmark-01') {
  await page.evaluate(({ action, id }) => { const button = document.createElement('button'); button.dataset.action = action; button.dataset.id = id; document.querySelector('.dj-main')!.append(button); button.click(); }, { action, id });
}

test('游客默认页、参数不授权演示、动作防护、五页手机与桌面排版和焦点', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await mkdir('var/qa/visitor', { recursive: true });
  await page.goto(home + '?sample=1'); await expect(page.getByTestId('claim-count')).toContainText('0');
  await expect(page.locator('.dj-sample-banner')).toHaveCount(0);
  for (const view of ['home', 'collection', 'rewards', 'photos', 'journey']) {
    await nav(page, view);
    await expect(page.locator('[data-action=visit], [data-action=receive], [data-action=bind-tag], [data-action=reset-sample]')).toHaveCount(0);
    expect(await page.locator('.dj-main').innerText()).not.toMatch(/宿主|适配器|从这里开始演示|Demo|素材待交付/);
    for (const width of [320, 375, 430, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 375 || width === 1280 && view === 'home') await page.screenshot({ path: `var/qa/visitor/${view}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await nav(page, 'collection'); await expect(page.locator('[data-action=photo-checkin]')).toHaveCount(6);
  for (const b of await page.locator('[data-action=photo-checkin]').all()) await expect(b).toBeEnabled();
  const art = page.locator('.dj-ticket-art').first(); await art.click();
  await expect(page.getByLabel('关闭弹窗')).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('dialog').locator('[data-action=photo-checkin]')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(art).toBeFocused();
  await inject(page, 'visit'); await expect(page.locator('.dj-toast')).toContainText('记录未改变');
  await nav(page, 'rewards'); await inject(page, 'redeem', 'gift-charm'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('balance')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('游客照片打卡：相册和拍照、选图与取消、错误重试、六景积分、刷新和纪念网址回看', async ({ page, context }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.url().includes('/magnets/')) requests.push(req.url()); });
  const buffer = await sharp({ create: { width: 96, height: 144, channels: 3, background: '#8ca89b' } }).png().toBuffer();
  const photo = { name: '旅行照片.png', mimeType: 'image/png', buffer };
  await page.goto(home + '/collection');
  const first = page.locator('[data-action=photo-checkin]').first(); await first.click();
  const dialog = page.getByRole('dialog', { name: '照片打卡', exact: true });
  await expect(dialog.locator('[data-action=confirm-photo-checkin]')).toBeDisabled();
  await expect(dialog.locator('[data-checkin-file=camera]')).toHaveAttribute('capture', 'environment');
  // A real file-picker gesture, cancelled before selecting, must not award points.
  const picker = page.waitForEvent('filechooser'); await dialog.locator('[data-action=checkin-camera]').click();
  await (await picker).setFiles([]); await expect(dialog.locator('[data-action=confirm-photo-checkin]')).toBeDisabled();
  await page.getByLabel('关闭弹窗').click(); await expect(first).toBeFocused();
  await nav(page, 'home'); await expect(page.getByTestId('balance')).toHaveText('0');
  await nav(page, 'collection'); await first.click();
  await dialog.locator('[data-checkin-file=gallery]').setInputFiles({ name: 'bad.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') });
  await expect(dialog.getByRole('alert')).toContainText('请选择 JPEG'); await expect(dialog.locator('[data-action=confirm-photo-checkin]')).toBeDisabled();
  // Header alone is insufficient: decoding a corrupt image must also fail.
  await dialog.locator('[data-checkin-file=gallery]').setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([255, 216, 255, 0]) });
  await expect(dialog.getByRole('alert')).toContainText('无法读取');
  const gallery = page.waitForEvent('filechooser'); await dialog.locator('[data-action=checkin-gallery]').click(); await (await gallery).setFiles(photo);
  await expect(dialog.locator('[data-action=confirm-photo-checkin]')).toBeEnabled();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.locator('img')).toBeVisible(); await expect(dialog.locator('[data-action=confirm-photo-checkin]')).toBeEnabled();
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `var/qa/visitor/photo-checkin-${width}.png`, fullPage: true });
  }
  await dialog.locator('[data-action=confirm-photo-checkin]').click();
  await expect(page.getByRole('dialog', { name: '地标交子详情' })).toContainText('照片打卡');
  await expect(page.locator('.dj-checkin-memory img')).toBeVisible();
  expect(await page.locator('.dj-checkin-memory img').evaluate((img: HTMLImageElement) => img.naturalHeight / img.naturalWidth)).toBe(1.5);
  await page.getByLabel('关闭弹窗').click(); await expect(first).toBeDisabled();
  await nav(page, 'home'); await expect(page.getByTestId('balance')).toHaveText('10'); await expect(page.getByTestId('map-element')).toHaveCount(1);
  await page.reload(); await expect(page.getByTestId('balance')).toHaveText('10');
  await nav(page, 'journey'); await page.getByLabel('旅程名称', { exact: true }).fill('照片里的成都'); await page.locator('[data-action=save-journey]').click();
  await expect(page.getByTestId('saved-title')).toHaveText('照片里的成都');
  const url = await page.getByLabel('此旅程专属网址').inputValue();
  const reopened = await context.newPage(); await reopened.goto(url); await expect(reopened.getByTestId('map-element')).toHaveCount(1);
  await reopened.getByTestId('map-element').click(); await expect(reopened.locator('.dj-checkin-memory img')).toBeVisible(); await reopened.close();
  // The other five landmarks can use the same photo; each still awards only once.
  await nav(page, 'collection');
  for (let i = 1; i < 6; i++) {
    await page.locator('[data-action=photo-checkin]').nth(i).click();
    await dialog.locator('[data-checkin-file=gallery]').setInputFiles(photo);
    await expect(dialog.locator('[data-action=confirm-photo-checkin]')).toBeEnabled();
    await dialog.locator('[data-action=confirm-photo-checkin]').click();
    await expect(page.getByRole('dialog', { name: '地标交子详情' })).toBeVisible(); await page.getByLabel('关闭弹窗').click();
  }
  await nav(page, 'home'); await expect(page.getByTestId('balance')).toHaveText('60'); await expect(page.getByTestId('earned')).toHaveText('60'); await expect(page.getByTestId('map-element')).toHaveCount(6);
  await page.reload(); await expect(page.getByTestId('balance')).toHaveText('60');
  await nav(page, 'rewards'); await expect(page.locator('[data-action=redeem]').first()).toBeDisabled(); await expect(page.getByTestId('balance')).toHaveText('60');
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test('实际打卡回调更新一次，未开放兑换不扣分；纪念网址、通用NFC和未知标签', async ({ page, context }) => {
  await page.goto('/visitor-host.html#host'); await page.waitForFunction(() => (window as any).ready);
  await nav(page, 'collection'); await page.locator('[data-action=host-checkin]').first().click();
  await expect(page.locator('.dj-collected')).toHaveCount(1); await nav(page, 'home');
  await expect(page.getByTestId('balance')).toHaveText('10'); await expect(page.getByTestId('map-element')).toHaveCount(1);
  await nav(page, 'rewards'); await inject(page, 'confirm-redeem', 'gift-charm'); await expect(page.getByTestId('balance')).toHaveText('10');
  await nav(page, 'journey'); await page.getByLabel('旅程名称', { exact: true }).fill('游客的成都记忆');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByLabel('旅程名称', { exact: true })).toHaveValue('游客的成都记忆');
  await page.locator('[data-action=save-journey]').click(); await expect(page.getByTestId('saved-title')).toHaveText('游客的成都记忆');
  const url = await page.getByLabel('此旅程专属网址').inputValue();
  const reopened = await context.newPage(); await reopened.goto(url); await expect(reopened.getByTestId('map-element')).toHaveCount(1);
  await reopened.screenshot({ path: 'var/qa/visitor/journey-saved-375.png', fullPage: true });
  await reopened.goto(home + '/journey'); await expect(reopened.getByTestId('saved-title')).toHaveText('游客的成都记忆');
  await reopened.goto(home + '/journey?tagId=missing'); await expect(reopened.getByRole('heading', { name: '当前浏览器暂无这段旅程' })).toBeVisible();
  await expect(reopened.getByTestId('saved-title')).toHaveCount(0);
  await reopened.goto(url); await reopened.locator('[data-action=copy-url]').click(); await expect(reopened.locator('.dj-toast')).toContainText(/已复制|手动复制/);
});

test('活动兑换加载、失败重试、回执与取消按服务返回；游客无法核销', async ({ page }) => {
  await page.goto('/visitor-host.html?rewards=1'); await page.waitForFunction(() => (window as any).ready);
  await nav(page, 'rewards'); await expect(page.getByTestId('balance')).toHaveText('60');
  await page.evaluate(() => { (window as any).failLoad = true; }); await page.locator('[data-action=refresh-rewards]').click();
  await expect(page.getByRole('alert')).toContainText('暂时无法读取'); await expect(page.locator('[data-action=redeem]').first()).toBeDisabled();
  await page.evaluate(() => { (window as any).failLoad = false; (window as any).failRedeem = true; }); await page.locator('[data-action=refresh-rewards]').click();
  await page.locator('[data-action=redeem]').first().click(); await page.locator('[data-action=confirm-redeem]').click();
  await expect(page.getByRole('alert')).toContainText('尚未确认兑换结果');
  await page.locator('[data-action=refresh-rewards]').click(); await expect(page.locator('.dj-order')).toHaveCount(1);
  await expect(page.getByTestId('balance')).toHaveText('40'); await expect(page.locator('.dj-receipt')).toContainText('凭证 1234');
  // The uncertain operation retains its id across re-opening the confirmation.
  await page.locator('[data-action=redeem]').first().click(); await page.locator('[data-action=confirm-redeem]').click();
  expect(await page.evaluate(() => new Set((window as any).rewardCalls).size)).toBe(1);
  await expect(page.getByTestId('balance')).toHaveText('40'); await expect(page.locator('[data-action=receive]')).toHaveCount(0);
  const orderId = await page.locator('[data-action=cancel]').getAttribute('data-id'); await inject(page, 'receive', orderId!);
  await expect(page.locator('.dj-order')).toContainText('待领取');
  await page.evaluate(() => { (window as any).failCancel = true; }); await page.locator('[data-action=cancel]').click();
  await expect(page.getByRole('alert')).toContainText('尚未确认取消结果');
  await page.evaluate(() => { (window as any).failCancel = false; }); await page.locator('[data-action=refresh-rewards]').click();
  await page.locator('[data-action=cancel]').click(); await expect(page.getByTestId('balance')).toHaveText('60');
  await expect(page.locator('.dj-order')).toContainText('已取消');
  expect(await page.evaluate(async () => (await (window as any).dj.getState()).wallet.balance)).toBe(0);
});

test('旧个人档案中的演示来源保留且分开显示；重置演示不影响个人照片和记录', async ({ page }) => {
  await page.goto('/preview/demo.html#/digital-jiaozi/collection'); await page.locator('[data-action=visit]').first().click();
  await nav(page, 'journey'); await page.locator('[data-action=sample-route]').click(); await page.locator('[data-action=save-journey]').click();
  await expect(page.getByTestId('saved-title')).toBeVisible();
  // Seed the previous release's personal format into this isolated test context.
  await page.goto(home);
  await page.evaluate(async () => {
    const open = (name: string) => new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
    const sample = await open('digital-jiaozi:sample'), personal = await open('digital-jiaozi:personal');
    for (const name of [...sample.objectStoreNames]) {
      const rows = await new Promise<any[]>(resolve => { const r = sample.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); });
      await new Promise<void>((resolve, reject) => { const t = personal.transaction(name, 'readwrite'); rows.forEach(row => t.objectStore(name).put(row)); t.oncomplete = () => resolve(); t.onabort = () => reject(t.error); });
    }
    sample.close(); personal.close();
  });
  await page.reload(); await expect(page.getByTestId('balance')).toHaveText('0'); await expect(page.getByTestId('map-element')).toHaveCount(0);
  await expect(page.locator('.dj-legacy summary')).toBeVisible(); await page.locator('.dj-legacy summary').click(); await expect(page.locator('.dj-legacy')).toContainText('旧余额 10');
  await nav(page, 'journey'); await expect(page.locator('.dj-notice')).toContainText('不代表真实到访'); await expect(page.getByTestId('map-element')).toHaveCount(1);
  await page.goto('/preview/demo.html#/digital-jiaozi'); await page.locator('[data-action=reset-sample]').click(); await expect(page.getByTestId('balance')).toHaveText('0');
  await page.locator('[data-action=personal]').click(); await expect(page.locator('.dj-legacy')).toContainText('旧余额 10');
  await page.reload(); await expect(page.locator('.dj-legacy')).toContainText('旧余额 10');
  await page.goto('/visitor-host.html'); await page.waitForFunction(() => (window as any).ready);
  const projection = await page.evaluate(async () => {
    const api = (window as any).dj;
    const events: any[] = []; const off = api.on((event: any) => events.push(event));
    const active = await api.getContext();
    const input = { activityId: 'six-landmarks-2026-v1', journeyId: active.id, occurredAt: '2026-11-01T07:00:00Z' };
    let conflict = '';
    try { await api.acceptCheckin({ ...input, eventId: 'mixed-old', landmarkId: 'landmark-01' }); }
    catch (error) { conflict = (error as any).code; }
    await api.acceptCheckin({ ...input, eventId: 'mixed-new', landmarkId: 'landmark-02' });
    off();
    return { conflict, wallets: events.map(e => e.wallet.balance), raw: (await api.getState()).wallet.balance, visitor: (await api.getVisitorState()).wallet.balance };
  });
  expect(projection).toEqual({ conflict: 'SOURCE_CONFLICT', wallets: [10, 10], raw: 20, visitor: 10 });
  await expect(page.getByTestId('balance')).toHaveText('10');
});
