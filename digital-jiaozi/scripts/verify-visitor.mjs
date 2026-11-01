// Local visitor smoke test. All generation POSTs are intercepted; no paid API calls.
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const destination = 'var/qa/visitor-live';
await mkdir(destination, { recursive: true });
const base = 'http://localhost:5188';
const status = await (await fetch(base + '/api/digital-jiaozi/magnets/status')).json();
assert.equal(status.configured, true, 'The existing local AI service must be configured.');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
const page = await context.newPage();
const errors = [], consoleErrors = []; let simulatedPosts = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const panel = await sharp(Buffer.from('<svg width="360" height="480"><rect width="360" height="480" fill="#ece6d9"/><rect x="70" y="110" width="220" height="180" rx="35" fill="#385d4c"/><path d="M100 210 180 140l80 70" fill="none" stroke="#e9c99b" stroke-width="9"/><text x="180" y="380" text-anchor="middle" font-size="18" fill="#385d4c">SIMULATED UI FIXTURE</text></svg>')).png().toBuffer();
const photo = await sharp(Buffer.from('<svg width="900" height="600"><rect width="900" height="600" fill="#a1c0b5"/><circle cx="680" cy="140" r="65" fill="#f1d793"/><path d="m0 520 300-330 250 220 180-150 170 260" fill="#3d6656"/></svg>')).png().toBuffer();
let release; const delayed = new Promise(resolve => { release = resolve; });
// Context-wide interception installed before navigation: only status GET reaches the live service.
await context.route('**/api/digital-jiaozi/magnets/**', async route => {
  if (route.request().url().endsWith('/status') && route.request().method() === 'GET') return route.continue();
  if (route.request().method() !== 'POST') return route.abort();
  simulatedPosts++;
  const raw = route.request().postDataBuffer().toString('latin1');
  const requestId = /name="requestId"\r\n\r\n([^\r]+)/.exec(raw)[1];
  await delayed;
  return route.fulfill({ json: { requestId, imageBase64: panel.toString('base64'), mime: 'image/png', width: 360, height: 480, sha256: createHash('sha256').update(panel).digest('hex'), provider: 'synthetic-test-only', model: 'ui-fixture', generatedAt: new Date().toISOString() } });
});
try {
  await page.goto(base + '/#/digital-jiaozi');
  await expect(page.getByTestId('balance')).toHaveText('0');
  await expect(page.locator('[data-action=visit], [data-action=sample]')).toHaveCount(0);
  await page.screenshot({ path: destination + '/home-375.png', fullPage: true });
  for (const view of ['home', 'collection', 'rewards', 'journey', 'photos']) {
    await page.locator(`nav [data-id=${view}]`).click();
    for (const width of [320, 375, 430, 1280]) {
      await page.setViewportSize({ width, height: 812 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${view} at ${width}`);
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('nav [data-id=collection]').click();
  await page.locator('[data-action=photo-checkin]').first().click();
  const checkin = page.getByRole('dialog', { name: '照片打卡', exact: true });
  await checkin.locator('[data-checkin-file=gallery]').setInputFiles({ name: 'synthetic-checkin.png', mimeType: 'image/png', buffer: photo });
  await expect(checkin.locator('[data-action=confirm-photo-checkin]')).toBeEnabled();
  await page.screenshot({ path: destination + '/photo-checkin-preview.png' });
  await checkin.locator('[data-action=confirm-photo-checkin]').click();
  await expect(page.locator('.dj-checkin-memory img')).toBeVisible();
  assert.equal(await page.locator('.dj-checkin-memory img').evaluate(img => img.naturalWidth / img.naturalHeight), 1.5);
  await page.screenshot({ path: destination + '/photo-checkin-detail.png' });
  await page.getByLabel('关闭弹窗').click();
  await expect(page.locator('[data-action=photo-checkin]').first()).toBeDisabled();
  await page.locator('nav [data-id=home]').click();
  await expect(page.getByTestId('balance')).toHaveText('10');
  await expect(page.getByTestId('map-element')).toHaveCount(1);
  await page.reload(); await expect(page.getByTestId('balance')).toHaveText('10');
  await page.locator('nav [data-id=journey]').click();
  await page.getByLabel('旅程名称', { exact: true }).fill('照片里的成都');
  await page.locator('[data-action=save-journey]').click();
  await expect(page.getByTestId('saved-title')).toHaveText('照片里的成都');
  const savedUrl = await page.getByLabel('此旅程专属网址').inputValue();
  const reopened = await context.newPage();
  reopened.on('pageerror', error => errors.push(error.message));
  await reopened.goto(savedUrl); await expect(reopened.getByTestId('map-element')).toHaveCount(1);
  await reopened.getByTestId('map-element').click();
  await expect(reopened.locator('.dj-checkin-memory img')).toBeVisible();
  await reopened.screenshot({ path: destination + '/photo-checkin-reopened.png' });
  await reopened.close();
  await page.locator('nav [data-id=photos]').click();
  await expect(page.getByText('AI生成服务已连接', { exact: false })).toBeVisible();
  await page.screenshot({ path: destination + '/photos-connected-375.png', fullPage: true });
  await page.getByLabel('冰箱贴选择照片', { exact: true }).setInputFiles({ name: 'synthetic-landscape.png', mimeType: 'image/png', buffer: photo });
  await page.getByRole('button', { name: '一键生成珐琅冰箱贴', exact: true }).click();
  await expect(page.locator('.dj-magnet-edit [role=progressbar]')).toBeVisible();
  await expect(page.locator('.dj-magnet-source')).toHaveCount(0);
  await page.locator('.dj-magnet-edit > :first-child').screenshot({ path: destination + '/generation-waiting.png' });
  release();
  await expect(page.locator('.dj-magnet-original')).toBeVisible();
  await page.locator('.dj-magnet-result').screenshot({ path: destination + '/generated-simulated.png' });
  const downloaded = page.waitForEvent('download'); await page.locator('[data-magnet-action=download-panel]').click();
  await (await downloaded).saveAs(destination + '/original-simulated.png');
  assert.deepEqual(await readFile(destination + '/original-simulated.png'), panel);
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible();
  await page.locator('[data-action=library]').click(); await expect(page.locator('.dj-magnet-card')).toBeInViewport();
  assert.equal(simulatedPosts, 1); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  const report = { url: base + '/#/digital-jiaozi', configured: status.configured, widths: [320, 375, 430, 1280], views: 5, photoCheckin: { awarded: 10, fullComposition: true, refreshRestored: true, journeyPhotoRestored: true }, simulatedPosts, paidCalls: 0, originalBytesEqual: true, refreshRestored: true, errors, consoleErrors, capturedAt: new Date().toISOString() };
  await writeFile(destination + '/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { release(); await context.close(); await browser.close(); }
