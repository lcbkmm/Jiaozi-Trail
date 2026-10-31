// Explicit, one-shot paid integration check. Never run by npm test or during builds.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
if (!process.argv.includes('--run-once')) throw new Error('This check requires an explicitly authorized --run-once invocation.');
const folder = 'var/qa/magnet-live', receipt = folder + '/attempt.json';
await mkdir(folder, { recursive: true });
try { await access(receipt); throw new Error('A live attempt is already recorded. Do not automatically repeat a paid request.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const source = await sharp(Buffer.from('<svg width="900" height="600"><rect width="900" height="600" fill="#b8d1d8"/><rect y="400" width="900" height="200" fill="#668e6f"/><path d="M220 290L450 120L680 290Z" fill="#a84e3a"/><rect x="270" y="290" width="360" height="240" fill="#eed9a4"/><rect x="400" y="360" width="100" height="170" fill="#695343"/><rect x="305" y="320" width="65" height="80" fill="#507c94"/><rect x="530" y="320" width="65" height="80" fill="#507c94"/><circle cx="750" cy="100" r="45" fill="#ebcc72"/></svg>')).png().toBuffer();
await writeFile(folder + '/synthetic-reference.png', source);
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
const page = await context.newPage(); let requests = 0, returned;
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/digital-jiaozi/magnets/generate')) requests++; });
page.on('response', async response => {
  if (response.request().method() === 'POST' && response.url().endsWith('/api/digital-jiaozi/magnets/generate') && response.ok()) returned = await response.json();
});
const started = Date.now();
try {
  await page.goto('http://localhost:5188/#/digital-jiaozi/photos');
  await expect(page.locator('.dj-magnet-service')).toContainText('已连接');
  await page.getByLabel('冰箱贴选择照片', { exact: true }).setInputFiles({ name: 'synthetic-reference.png', mimeType: 'image/png', buffer: source });
  await expect(page.locator('[data-magnet-action=generate]')).toBeEnabled();
  await expect(page.locator('.dj-magnet textarea, .dj-magnet select, .dj-magnet input[type=color]')).toHaveCount(0);
  await writeFile(receipt, JSON.stringify({ startedAt: new Date().toISOString(), state: 'ABOUT_TO_SEND', input: 'program-drawn-synthetic-building', automaticRetry: false }, null, 2));
  await page.locator('[data-magnet-action=generate]').click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible({ timeout: 240000 });
  const elapsedSeconds = (Date.now() - started) / 1000;
  expect(requests).toBe(1); expect(returned?.model).toBe('gpt-image-2');
  const bytes = Buffer.from(returned.imageBase64, 'base64');
  const download = page.waitForEvent('download'); await page.locator('[data-magnet-action=download-panel]').click();
  await (await download).saveAs(folder + '/generated-original.png');
  expect(await readFile(folder + '/generated-original.png')).toEqual(bytes);
  const meta = await sharp(bytes).metadata(); await sharp(bytes).stats();
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(returned.sha256);
  await page.locator('.dj-magnet-result').first().screenshot({ path: folder + '/original-mobile.png' });
  await page.getByRole('button', { name: '制作纪念海报', exact: true }).click();
  await page.locator('[name=magnet-confirm-crop]').check(); await page.locator('[data-magnet-action=compose]').click();
  await expect(page.locator('.dj-magnet-poster')).toBeVisible();
  const poster = page.waitForEvent('download'); await page.locator('[data-magnet-action=download-poster]').click();
  await (await poster).saveAs(folder + '/poster.png');
  await page.locator('.dj-magnet-poster').screenshot({ path: folder + '/poster-mobile.png' });
  await page.reload(); await page.locator('.dj-magnet-card').first().click(); await expect(page.locator('.dj-magnet-original')).toBeVisible();
  const restored = page.waitForEvent('download'); await page.locator('[data-magnet-action=download-panel]').click();
  await (await restored).saveAs(folder + '/original-restored.png'); expect(await readFile(folder + '/original-restored.png')).toEqual(bytes);
  expect(requests).toBe(1);
  const verified = { state: 'VERIFIED', verifiedAt: new Date().toISOString(), input: 'program-drawn-synthetic-building', requests, model: returned.model, provider: returned.provider, elapsedSeconds, width: meta.width, height: meta.height, sha256: returned.sha256, originalDownloadByteEqual: true, reloadByteEqual: true, poster: { width: 900, height: 1200 }, viewport: 'Edge 375x812; not a physical phone' };
  await writeFile(receipt, JSON.stringify(verified, null, 2)); console.log(JSON.stringify(verified));
} catch (error) {
  await page.screenshot({ path: folder + '/failure.png', fullPage: true }).catch(() => {});
  console.error('Live verification did not complete. Check the local screenshot and attempt receipt; no automatic retry.');
  process.exitCode = 1;
} finally { await browser.close(); }
