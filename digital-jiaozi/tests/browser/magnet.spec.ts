import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

const photos = '/preview/#/digital-jiaozi/photos';
const prefix = '/api/digital-jiaozi/magnets';
// Synthetic test panel: a green circle on neutral background. Never presented as a real model verification.
const panel = await sharp(Buffer.from('<svg width="240" height="320"><rect width="240" height="320" fill="#e8e0d4"/><circle cx="120" cy="85" r="55" fill="#3f7868"/></svg>')).png().toBuffer();
const landscape = await sharp(Buffer.from('<svg width="1200" height="600"><rect width="600" height="600" fill="#ed3020"/><rect x="600" width="600" height="600" fill="#205bed"/><rect x="1050" y="50" width="100" height="100" fill="#f9db38"/></svg>')).png().toBuffer();
const response = (requestId: string) => ({ requestId, imageBase64: panel.toString('base64'), mime: 'image/png', width: 240, height: 320, sha256: createHash('sha256').update(panel).digest('hex'), provider: 'synthetic-test-only', model: 'test-panel', generatedAt: new Date().toISOString() });
async function mock(page: Page, options: { configured?: boolean; delay?: Promise<void>; failure?: { status: number; uncertain: boolean; message: string } } = {}) {
  const calls: { count: number; recoveries: number; requestIds: string[] } = { count: 0, recoveries: 0, requestIds: [] };
  await page.route('**' + prefix + '/**', async route => {
    if (route.request().url().endsWith('/status')) { await route.fulfill({ json: { configured: options.configured ?? true, timeoutMs: 180000 } }); return; }
    if (route.request().method() === 'GET' && route.request().url().includes('/results/')) {
      calls.recoveries++;
      const requestId = route.request().url().split('/').at(-1)!;
      await route.fulfill({ json: response(requestId) }); return;
    }
    calls.count++;
    const raw = route.request().postDataBuffer()!.toString('latin1');
    const requestId = /name="requestId"\r\n\r\n([^\r]+)/.exec(raw)![1]; calls.requestIds.push(requestId);
    expect(raw).toContain('name="image"; filename="reference.png"');
    expect(raw).toContain('name="category"\r\n\r\nauto');
    expect(raw).not.toMatch(/name="(?:subjectDescription|backgroundColor|title|place|year)"/);
    expect(raw).not.toContain('api_key');
    await options.delay;
    if (options.failure) { await route.fulfill({ status: options.failure.status, json: { error: { code: 'TEST_FAILURE', ...options.failure } } }); return; }
    await route.fulfill({ json: response(requestId) });
  });
  return calls;
}
async function select(page: Page, buffer = landscape, name = 'asymmetric-test.png') {
  await page.getByLabel('冰箱贴选择照片', { exact: true }).setInputFiles({ name, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', buffer });
  await expect(page.locator('[data-magnet-action=generate]')).toBeVisible();
  await expect(page.locator('[data-magnet-status]')).toContainText('照片已就绪');
  await expect(page.locator('.dj-magnet-source')).toBeVisible();
}
async function adjustPhoto(page: Page) {
  if (!await page.locator('[data-magnet-adjustments]').evaluate((e: HTMLDetailsElement) => e.open)) await page.locator('[data-magnet-adjustments] summary').click();
}
async function storedWorks(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('digital-jiaozi:magnet:personal'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const works = await new Promise<any[]>((resolve, reject) => { const r = db.transaction('works').objectStore('works').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return works.map(w => ({ title: w.title, category: w.category, subject: w.subjectDescription, width: w.sourceWidth, height: w.sourceHeight }));
    } finally { db.close(); }
  });
}
// Model a pre-existing saved draft, retaining compatibility with old titles and manual instructions.
async function restoreLegacyDraft(page: Page, title: string) {
  await page.evaluate(async title => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('digital-jiaozi:magnet:personal'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('works', 'readwrite'), store = tx.objectStore('works'), r = store.getAll();
        r.onsuccess = () => { const w = r.result[0]; store.put({ ...w, title, category: 'scenery', subjectDescription: '旧版手动主体，不应传给模型' }); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, title);
  await page.reload(); await page.locator('.dj-magnet-card').filter({ hasText: title }).click();
}
async function generate(page: Page) {
  await page.locator('[data-magnet-action=generate]').click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible();
  await expect(page.locator('[data-magnet-action=generate]')).toBeEnabled();
}
async function compose(page: Page) {
  await page.getByRole('button', { name: '制作纪念海报', exact: true }).click();
  await page.locator('[name=magnet-confirm-crop]').check();
  await page.locator('[data-magnet-action=compose]').click();
  await expect(page.locator('.dj-magnet-poster')).toBeVisible();
  await expect(page.locator('[data-magnet-action=compose]')).toBeEnabled();
}
async function downloaded(page: Page, action: string, filename: string) {
  const pending = page.waitForEvent('download'); await page.locator(`[data-magnet-action=${action}]`).click();
  const download = await pending; await download.saveAs(filename); return readFile(filename);
}

test('上传后无需填表或调整即可一键生成；选图和刷新不自动发单，生成原图可下载并恢复', async ({ page }) => {
  const calls = await mock(page); await page.goto(photos); await select(page);
  await expect(page.locator('[data-magnet-adjustments]')).not.toHaveAttribute('open');
  await expect(page.locator('.dj-magnet textarea, .dj-magnet select, .dj-magnet input[type=color], .dj-magnet input[type=text]')).toHaveCount(0);
  await expect(page.locator('.dj-magnet [name^="magnet-"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '一键生成珐琅冰箱贴', exact: true })).toBeEnabled();
  expect(calls.count).toBe(0);
  await generate(page); expect(calls.count).toBe(1);
  await mkdir('var/qa/one-click', { recursive: true });
  expect(await downloaded(page, 'download-panel', 'var/qa/one-click/original.png')).toEqual(panel);
  expect(await storedWorks(page)).toMatchObject([{ category: 'auto', subject: '', title: '' }]);
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible(); expect(calls.count).toBe(1);
  // Existing outputs require explicit confirmation before a new paid attempt.
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-magnet-action=generate]').click(); expect(calls.count).toBe(1);
});

test('点阵预览从0开始，等待进度有上限且重绘不重置；真实图片就绪后100再显示作品', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-31T13:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-31T13:00:01Z'));
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const calls = await mock(page, { delay: pending }); await page.goto(photos); await select(page);
  await expect(page.locator('.dj-magnet-card img')).toHaveCount(0);
  await expect(page.locator('.dj-magnet-card')).toContainText('尚未生成');
  await adjustPhoto(page);
  await expect(page.locator('[data-magnet-photo-preview]')).toBeVisible();
  await page.locator('[data-magnet-action=generate]').click();
  const progress = page.locator('.dj-magnet-edit [role=progressbar]');
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  await expect(page.locator('.dj-magnet-source, .dj-magnet-original, .dj-magnet-card img')).toHaveCount(0);
  await expect(page.locator('[data-magnet-photo-preview]')).toHaveCount(0);
  await expect(page.locator('.dj-magnet-library [role=progressbar]')).toHaveAttribute('aria-valuenow', '0');
  await page.clock.runFor(15000);
  const before = Number(await progress.getAttribute('aria-valuenow')); expect(before).toBeGreaterThan(0); expect(before).toBeLessThan(95);
  await page.locator('[data-magnet-action=check-service]').click();
  await expect(progress).toHaveAttribute('aria-valuenow', String(before));
  await page.clock.fastForward(165000);
  await expect(progress).toHaveAttribute('aria-valuenow', '95');
  await expect(page.locator('.dj-magnet-library [role=progressbar]')).toHaveAttribute('aria-valuenow', '95');
  await expect(page.locator('.dj-magnet-original, .dj-magnet-card img')).toHaveCount(0);
  for (const width of [320, 375, 430, 1365]) {
    await page.setViewportSize({ width, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await mkdir('var/qa/generation-progress', { recursive: true });
  await page.locator('.dj-magnet-edit [data-magnet-generation]').screenshot({ path: 'var/qa/generation-progress/loading-375.png', animations: 'allow' });
  release(); await expect(progress).toHaveAttribute('aria-valuenow', '100');
  await expect(page.locator('.dj-magnet-edit [data-generation-label]')).toHaveText('生成完成');
  await expect(page.locator('.dj-magnet-original')).toHaveCount(0);
  await page.clock.runFor(550);
  await expect(page.locator('.dj-magnet-original')).toBeVisible();
  await expect(page.locator('.dj-magnet-edit > :first-child')).toHaveClass('dj-magnet-result');
  await expect(page.locator('.dj-magnet-source')).not.toBeVisible();
  await expect(page.locator('.dj-magnet-card img')).toHaveCount(1);
  await expect(page.locator('[role=progressbar]')).toHaveCount(0); expect(calls.count).toBe(1);
});

test('再次生成隐藏上次图片；失败和刷新显示待确认卡片，停止百分比且不自动重发；支持减少动态效果', async ({ page }) => {
  await mock(page); await page.goto(photos); await select(page); await generate(page);
  await page.unroute('**' + prefix + '/**');
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const calls = await mock(page, { delay: pending, failure: { status: 504, uncertain: true, message: '结果暂未确认' } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.once('dialog', dialog => dialog.accept()); await page.locator('[data-magnet-action=generate]').click();
  await expect(page.locator('.dj-magnet-original, .dj-magnet-source, .dj-magnet-card img')).toHaveCount(0);
  const dots = page.locator('.dj-magnet-edit .dj-generation-dots i').first();
  await expect(dots).toHaveCSS('animation-name', 'none');
  release(); await expect(page.locator('[data-magnet-error]')).toContainText('结果暂未确认');
  await expect(page.locator('[role=progressbar]')).toHaveCount(0);
  await expect(page.locator('.dj-magnet-edit [data-generation-label]')).toHaveText('等待确认结果');
  await expect(page.locator('.dj-magnet-card img, .dj-magnet-original')).toHaveCount(0);
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-edit [data-generation-label]')).toHaveText('等待确认结果');
  await expect(page.locator('[role=progressbar]')).toHaveCount(0); expect(calls.count).toBe(1);
  await page.locator('[data-magnet-action=recover]').click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible();
  await expect(page.locator('.dj-magnet-card img')).toHaveCount(1);
  expect(calls.count).toBe(1); expect(calls.recoveries).toBe(1);
});

test('返回图片未通过完整性校验时不出现100或作品图，保留待确认状态', async ({ page }) => {
  await mock(page); await page.goto(photos); await select(page);
  await page.route('**' + prefix + '/generate', async route => {
    const raw = route.request().postDataBuffer()!.toString('latin1');
    const requestId = /name="requestId"\r\n\r\n([^\r]+)/.exec(raw)![1];
    await route.fulfill({ json: { ...response(requestId), sha256: '0'.repeat(64) } });
  });
  await page.locator('[data-magnet-action=generate]').click();
  await expect(page.locator('[data-magnet-error]')).toContainText('完整性校验失败');
  await expect(page.locator('[role=progressbar], .dj-magnet-original, .dj-magnet-card img')).toHaveCount(0);
  await expect(page.locator('.dj-magnet-edit [data-generation-label]')).toHaveText('等待确认结果');
});

test('默认AI入口与本地贴片分开；带入原照片及名称不请求AI，主动生成才发单', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const calls = await mock(page); await page.goto(photos);
  await expect(page.getByRole('heading', { name: '照片生成珐琅冰箱贴', exact: true })).toBeVisible();
  await expect(page.locator('[data-photo-tools]')).not.toHaveAttribute('open');
  await expect(page.locator('[data-identify]')).toHaveCount(0);
  await page.locator('[data-photo-tools] summary').click();
  await page.getByLabel('选择相册照片', { exact: true }).setInputFiles({ name: 'local-photo.png', mimeType: 'image/png', buffer: landscape });
  await page.getByLabel('照片名称', { exact: true }).fill('旅途回忆');
  await page.locator('[data-rotate]').click();
  await page.getByLabel('照片缩放', { exact: true }).fill('2');
  await page.getByRole('button', { name: '预览裁剪 / 滤镜效果', exact: true }).click();
  await expect(page.locator('.dj-photo-preview')).toBeVisible(); expect(calls.count).toBe(0);
  // Returning from the OS picker or another tab must not close the local tool while it is in use.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('[data-photo-tools]')).toHaveAttribute('open');
  await page.locator('[data-open-magnet]').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.locator('[data-magnet-status]')).toContainText('原照片和名称已带入，尚未发送给 AI');
  expect(await storedWorks(page)).toMatchObject([{ title: '旅途回忆', category: 'auto', subject: '' }]);
  await expect(page.locator('[data-photo-tools]')).not.toHaveAttribute('open');
  await expect(page.locator('.dj-magnet-card')).toHaveCount(1); expect(calls.count).toBe(0);
  const imported = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('digital-jiaozi:magnet:personal'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const [w] = await new Promise<any[]>((resolve, reject) => { const r = db.transaction('works').objectStore('works').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return { width: w.sourceWidth, height: w.sourceHeight, bytes: Array.from(new Uint8Array(await w.originalPhoto.arrayBuffer())) };
    } finally { db.close(); }
  });
  // Transfer the full original, never the old tool's rotated square preview or filtered pixels.
  expect(imported.width).toBe(1200); expect(imported.height).toBe(600); expect(Buffer.from(imported.bytes)).toEqual(landscape);
  await generate(page); expect(calls.count).toBe(1);
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-card')).toContainText('旅途回忆');
  await expect(page.locator('.dj-magnet-original')).toBeVisible(); expect(calls.count).toBe(1);
  expect(errors).toEqual([]);
});

test('带入新照片前旧草稿保存失败时保留两个工具的照片，恢复后可重试且不发AI请求', async ({ page }) => {
  const calls = await mock(page); await page.goto(photos); await select(page);
  await page.locator('[data-photo-tools] summary').click();
  await page.getByLabel('选择相册照片', { exact: true }).setInputFiles({ name: 'another-local-photo.png', mimeType: 'image/png', buffer: panel });
  await page.getByLabel('照片名称', { exact: true }).fill('新照片');
  await page.evaluate(() => {
    const proto = IDBObjectStore.prototype, original = proto.put;
    (window as any).restoreMagnetStorage = () => { proto.put = original; };
    proto.put = function(...args) { if (this.transaction.db.name.startsWith('digital-jiaozi:magnet:')) throw new DOMException('full', 'QuotaExceededError'); return original.apply(this, args as [unknown, IDBValidKey?]); };
  });
  await page.locator('[data-open-magnet]').click();
  await expect(page.locator('.dj-editor-status')).toContainText('作品库保存失败');
  await expect(page.locator('[data-magnet-status]')).toContainText('未切换照片，原作品已保留');
  await expect(page.locator('[data-photo-tools]')).toHaveAttribute('open');
  await expect(page.locator('.dj-crop img')).toBeVisible();
  await expect(page.locator('.dj-magnet-source')).toHaveJSProperty('naturalWidth', 1200);
  await expect(page.locator('.dj-magnet-card')).toHaveCount(1); expect(calls.count).toBe(0);
  await page.evaluate(() => (window as any).restoreMagnetStorage());
  await page.locator('[data-open-magnet]').click();
  await expect(page.locator('[data-magnet-status]')).toContainText('原照片和名称已带入');
  await expect(page.locator('.dj-magnet-source')).toHaveJSProperty('naturalWidth', 240);
  await expect(page.locator('.dj-magnet-card')).toHaveCount(2); expect(calls.count).toBe(0);
});

test('冰箱贴完整流程：原图字节、独立海报、下半区真实裁切、调整不重发、刷新恢复及积分隔离', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const calls = await mock(page); await page.goto(photos); await select(page);
  await adjustPhoto(page);
  await page.getByLabel('冰箱贴水平焦点', { exact: true }).fill('1');
  await page.locator('[data-magnet-action=save]').click(); await expect(page.locator('[data-magnet-status]')).toContainText('草稿');
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await adjustPhoto(page); await expect(page.getByLabel('冰箱贴水平焦点', { exact: true })).toHaveValue('1'); expect(calls.count).toBe(0);
  await page.locator('[data-magnet-action=generate]').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.locator('.dj-magnet-original')).toBeVisible(); expect(calls.count).toBe(1);
  await mkdir('var/qa', { recursive: true });
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-original-test.png')).toEqual(panel);
  await compose(page);
  const poster = await downloaded(page, 'download-poster', 'var/qa/magnet-poster-test.png');
  const metadata = await sharp(poster).metadata(); expect(metadata.width).toBe(900); expect(metadata.height).toBe(1200);
  // Independently expected crop: a 1200×600 photo fills 3:2 by retaining the rightmost 900 pixels. No AI pixels involved.
  const expected = await sharp(landscape).extract({ left: 300, top: 0, width: 900, height: 600 }).removeAlpha().raw().toBuffer();
  const actual = await sharp(poster).extract({ left: 0, top: 600, width: 900, height: 600 }).removeAlpha().raw().toBuffer();
  expect(actual).toEqual(expected);
  await adjustPhoto(page);
  const previewSamples = await page.locator('[data-magnet-photo-preview]').evaluate(c => {
    const ctx = (c as HTMLCanvasElement).getContext('2d')!;
    return [100, 400].map(x => Array.from(ctx.getImageData(x, 200, 1, 1).data).slice(0, 3));
  }); expect(previewSamples).toEqual([[237,48,32],[32,91,237]]);
  await page.getByLabel('冰箱贴照片缩放', { exact: true }).fill('2');
  await page.locator('[name=magnet-confirm-crop]').check(); await page.locator('[data-magnet-action=compose]').click();
  await expect(page.locator('[data-magnet-status]')).toContainText('450 × 600'); expect(calls.count).toBe(1);
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible(); await expect(page.locator('.dj-magnet-poster')).toBeVisible();
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-original-restored.png')).toEqual(panel); expect(calls.count).toBe(1);
  for (const width of [320,375,430]) { await page.setViewportSize({ width, height: 812 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.dj-magnet-result').first().screenshot({ path: 'var/qa/magnet-original-mobile.png' });
  await page.locator('.dj-magnet-poster').screenshot({ path: 'var/qa/magnet-poster-mobile.png' });
  await page.locator('nav [data-id=home]').click(); await expect(page.getByTestId('balance')).toHaveText('0'); await expect(page.getByTestId('earned')).toHaveText('0'); await expect(page.getByTestId('claim-count')).toHaveText('0 / 6');
  await page.locator('nav [data-id=rewards]').click(); await expect(page.locator('.dj-order')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('未配置与坏照片有明确反馈；可保存并恢复草稿，不假生成', async ({ page }) => {
  const calls = await mock(page, { configured: false }); await page.goto(photos);
  await page.getByLabel('冰箱贴选择照片', { exact: true }).setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
  await expect(page.locator('[data-magnet-error]')).toContainText('请选择');
  await select(page); await page.locator('[data-magnet-action=save]').click();
  await expect(page.locator('[data-magnet-action=generate]')).toBeDisabled();
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-source')).toBeVisible();
  expect(await storedWorks(page)).toMatchObject([{ category: 'auto', subject: '' }]);
  expect(calls.count).toBe(0); await expect(page.locator('.dj-magnet-original')).toHaveCount(0);
});

test('横竖图、EXIF方向和小尺寸输出保持3:4，50%分界并且不放大', async ({ page }) => {
  await mock(page); await page.goto(photos);
  const portrait = await sharp(Buffer.from('<svg width="600" height="1200"><rect width="600" height="600" fill="#ed3020"/><rect y="600" width="600" height="600" fill="#205bed"/></svg>')).png().toBuffer();
  const exif = await sharp(landscape).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
  const small = await sharp({ create: { width: 17, height: 11, channels: 3, background: '#ed3020' } }).png().toBuffer();
  for (const [name, input, width, height] of [['portrait.png',portrait,600,800],['direction.jpg',exif,600,800],['small.png',small,15,20]] as const) {
    await select(page, input, name); await generate(page); await compose(page);
    const result = await downloaded(page, 'download-poster', `var/qa/magnet-${name}.png`);
    const meta = await sharp(result).metadata(); expect(meta.width).toBe(width); expect(meta.height).toBe(height);
    const pixel = await sharp(result).extract({ left: 1, top: height / 2 + 1, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(220); expect(pixel[2]).toBeLessThan(70);
  }
});

test('旧请求异步返回不覆盖新照片；刷新不自动重发未知任务；示例重置不删个人作品', async ({ page }) => {
  let release!: () => void; const pending = new Promise<void>(r => { release = r; });
  const calls = await mock(page, { delay: pending }); await page.goto(photos); await select(page);
  await page.locator('[data-magnet-action=generate]').click();
  await expect(page.locator('[data-magnet-action=generate]')).toContainText('生成中');
  await select(page, await sharp({ create: { width: 120, height: 80, channels: 3, background: '#00ab00' } }).png().toBuffer());
  await page.locator('[data-magnet-action=save]').click();
  release(); await expect(page.locator('[data-magnet-status]')).toContainText('上一张照片');
  await expect(page.locator('.dj-magnet-source')).toHaveJSProperty('naturalWidth', 120); await expect(page.locator('.dj-magnet-original')).toHaveCount(0);
  await page.reload(); await expect(page.locator('.dj-magnet-card')).toHaveCount(2); expect(calls.count).toBe(1);
  await page.locator('nav [data-id=home]').click(); await page.locator('[data-action=sample]').click();
  await expect(page.locator('.dj-sample-banner')).toBeVisible(); await page.locator('nav [data-id=photos]').click();
  await expect(page.locator('.dj-magnet-card')).toHaveCount(0); await select(page); await page.locator('nav [data-id=home]').click();
  await page.locator('[data-action=reset-sample]').click(); await page.locator('[data-action=personal]').click(); await page.locator('nav [data-id=photos]').click();
  await expect(page.locator('.dj-magnet-card')).toHaveCount(2);
});

test('未知结果、合成字体失败与存储失败均可恢复，原始图保留且合成重试不重发AI', async ({ page }) => {
  const calls = await mock(page); await page.goto(photos); await select(page); await restoreLegacyDraft(page, '字体失败测试'); await generate(page);
  await page.route('**/assets/fonts/**', route => route.abort());
  await page.getByRole('button', { name: '制作纪念海报', exact: true }).click(); await page.locator('[name=magnet-confirm-crop]').check();
  await page.locator('[data-magnet-action=compose]').click(); await expect(page.locator('.dj-magnet-composer [role=alert]')).toContainText('字体加载失败');
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-after-compose-failure.png')).toEqual(panel); expect(calls.count).toBe(1);
  await page.unroute('**/assets/fonts/**'); await page.locator('[name=magnet-confirm-crop]').check(); await page.locator('[data-magnet-action=compose]').click();
  await expect(page.locator('.dj-magnet-poster')).toBeVisible(); expect(calls.count).toBe(1);
  expect(await storedWorks(page)).toMatchObject([{ title: '字体失败测试', category: 'auto', subject: '' }]);
  await page.evaluate(() => { const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) { if (this.transaction.db.name.startsWith('digital-jiaozi:magnet:')) throw new DOMException('full', 'QuotaExceededError'); return original.apply(this, args as [unknown, IDBValidKey?]); }; });
  await page.locator('[name=magnet-confirm-crop]').check(); await page.locator('[data-magnet-action=compose]').click();
  await expect(page.locator('[data-magnet-error]')).toContainText('保存失败'); expect(calls.count).toBe(1);
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-after-storage-failure.png')).toEqual(panel);
  await page.reload(); await page.locator('.dj-magnet-card').first().click(); await expect(page.locator('.dj-magnet-poster')).toBeVisible();
});

test('模拟超时与401/429反馈保存任务；刷新后不自动重发', async ({ page }) => {
  for (const failure of [{ status: 504, uncertain: true, message: '结果暂未确认，供应商可能已计费' }, { status: 502, uncertain: false, message: '生成服务授权失败' }, { status: 429, uncertain: false, message: '生成服务繁忙或额度受限' }]) {
    await page.unroute('**' + prefix + '/**'); const calls = await mock(page, { failure });
    await page.goto(photos); await select(page); await page.locator('[data-magnet-action=generate]').click();
    await expect(page.locator('[data-magnet-error]')).toContainText(failure.message); expect(calls.count).toBe(1);
    await page.reload(); await page.locator('.dj-magnet-card').first().click(); expect(calls.count).toBe(1);
    await expect(page.locator('.dj-magnet-task')).toContainText(failure.message);
  }
});

test('刷新后主动查询临时结果只发GET，取回原图并持久保存', async ({ page }) => {
  const calls = await mock(page, { failure: { status: 504, uncertain: true, message: '结果暂未确认' } });
  await page.goto(photos); await select(page); await page.locator('[data-magnet-action=generate]').click();
  await expect(page.locator('[data-magnet-error]')).toContainText('结果暂未确认');
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  expect(calls.count).toBe(1); expect(calls.recoveries).toBe(0);
  await page.locator('[data-magnet-action=recover]').click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible();
  await expect(page.locator('[data-magnet-status]')).toContainText('没有发起新的 AI 请求');
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-cache-recovered.png')).toEqual(panel);
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible();
  expect(calls.count).toBe(1); expect(calls.recoveries).toBe(1);
});

test('AI成功后存储失败仍可下载原图，恢复存储后保存无需再次生图', async ({ page }) => {
  let release!: () => void; const pending = new Promise<void>(r => { release = r; });
  const calls = await mock(page, { delay: pending }); await page.goto(photos); await select(page);
  await page.locator('[data-magnet-action=generate]').click();
  await expect(page.locator('[data-magnet-action=generate]')).toContainText('生成中');
  await page.evaluate(() => {
    const proto = IDBObjectStore.prototype, original = proto.put;
    (window as any).restoreMagnetStorage = () => { proto.put = original; };
    proto.put = function(...args) { if (this.transaction.db.name.startsWith('digital-jiaozi:magnet:')) throw new DOMException('full', 'QuotaExceededError'); return original.apply(this, args as [unknown, IDBValidKey?]); };
  });
  release(); await expect(page.locator('.dj-magnet-original')).toBeVisible();
  await expect(page.locator('[data-magnet-error]')).toContainText('AI已成功，但本地保存失败');
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-unsaved-original.png')).toEqual(panel);
  await page.evaluate(() => (window as any).restoreMagnetStorage());
  await page.locator('[data-magnet-action=save]').click();
  await expect(page.locator('[data-magnet-status]')).toContainText('已保存');
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible(); expect(calls.count).toBe(1);
});

test('合成等待字体时检查服务和下载不会解除编辑锁或串入另一张照片', async ({ page }) => {
  const calls = await mock(page); await page.goto(photos); await select(page); await restoreLegacyDraft(page, '并发合成验证'); await generate(page); await adjustPhoto(page);
  let release!: () => void; const pending = new Promise<void>(r => { release = r; });
  let fontRequested = false;
  await page.route('**/assets/fonts/**', async route => { fontRequested = true; await pending; await route.continue(); });
  await page.getByRole('button', { name: '制作纪念海报', exact: true }).click();
  await page.locator('[name=magnet-confirm-crop]').check(); await page.locator('[data-magnet-action=compose]').click();
  await expect.poll(() => fontRequested).toBe(true);
  await page.locator('[data-magnet-action=check-service]').click();
  await expect(page.getByLabel('冰箱贴水平焦点', { exact: true })).toBeDisabled();
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-during-composition.png')).toEqual(panel);
  await page.getByLabel('冰箱贴选择照片', { exact: true }).setInputFiles({ name: 'other.png', mimeType: 'image/png', buffer: panel });
  await expect(page.locator('[data-magnet-action=generate]')).toBeDisabled();
  release(); await expect(page.locator('.dj-magnet-poster')).toBeVisible();
  await expect(page.locator('.dj-magnet-card')).toContainText('并发合成验证');
  await expect(page.locator('.dj-magnet-card')).toHaveCount(1); expect(calls.count).toBe(1);
});

test('局域网HTTP能力回退：无randomUUID和subtle时仍能保存并校验原图', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
    Object.defineProperty(crypto, 'subtle', { value: undefined });
  });
  const calls = await mock(page); await page.goto(photos); await select(page); await generate(page);
  expect(await downloaded(page, 'download-panel', 'var/qa/magnet-http-fallback.png')).toEqual(panel);
  await page.reload(); await page.locator('.dj-magnet-card').first().click();
  await expect(page.locator('.dj-magnet-original')).toBeVisible(); expect(calls.count).toBe(1);
});
