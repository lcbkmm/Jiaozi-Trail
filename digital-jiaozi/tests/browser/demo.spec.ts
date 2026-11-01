import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { ACTIVITY } from '../../src/config/rules.ts';
import { LANDMARKS } from '../../src/config/landmarks.ts';

const home = '/preview/demo.html#/digital-jiaozi';
async function nav(page: Page, id: string) { await page.locator(`nav [data-id="${id}"]`).click(); }
async function collect(page: Page, count = 6) {
  await nav(page, 'collection');
  for (let i = 1; i <= count; i++) {
    const button = page.locator(`[data-action=visit][data-id="landmark-0${i}"]`);
    await button.click(); await expect(button).toHaveText('已领取 · 不重复奖励');
  }
}
async function testPhoto() {
  // Clearly asymmetric synthetic fixture; never a private or generated user photograph.
  return sharp(Buffer.from('<svg width="800" height="400"><rect width="400" height="400" fill="#ed3020"/><rect x="400" width="400" height="400" fill="#205bed"/><circle cx="600" cy="100" r="60" fill="#f9db38"/></svg>')).png().toBuffer();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('生产构建：首次领取、六款、兑换20、刷新、保存路线、关闭重开指定NFC URL与tag', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(home); await expect(page.getByTestId('balance')).toHaveText('0');
  await collect(page, 1); await nav(page, 'home');
  await expect(page.getByTestId('balance')).toHaveText('10'); await expect(page.getByTestId('map-element')).toHaveCount(1);
  await page.reload(); await expect(page.getByTestId('balance')).toHaveText('10');
  await nav(page, 'collection');
  for (let i = 2; i <= 6; i++) { const btn = page.locator(`[data-action=visit][data-id="landmark-0${i}"]`); await btn.click(); await expect(btn).toBeDisabled(); }
  await nav(page, 'home'); await expect(page.getByTestId('balance')).toHaveText('60'); await expect(page.getByTestId('map-element')).toHaveCount(6);
  await mkdir('var/qa', { recursive: true }); await page.screenshot({ path: 'var/qa/web-home-375.png', fullPage: true });
  for (const width of [320, 375, 430]) { await page.setViewportSize({width,height:812}); await noOverflow(page); }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.dj-storage-note').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect((await page.locator('.dj-storage-note').boundingBox())!.y + (await page.locator('.dj-storage-note').boundingBox())!.height).toBeLessThan((await page.locator('nav').boundingBox())!.y);
  await nav(page, 'rewards'); await page.locator('[data-action=redeem][data-id=gift-charm]').click();
  await expect(page.getByRole('dialog')).toContainText('40'); await page.locator('[data-action=confirm-redeem]').click();
  await expect(page.getByTestId('balance')).toHaveText('40'); await page.reload(); await expect(page.getByTestId('balance')).toHaveText('40');
  await expect(page.locator('.dj-order')).toHaveCount(1); await nav(page, 'home');
  await expect(page.getByTestId('earned')).toHaveText('60'); await expect(page.getByTestId('map-element')).toHaveCount(6);
  await nav(page, 'journey'); await page.locator('[data-action=sample-route]').click();
  await page.getByLabel('旅程名称', {exact:true}).fill('六景体验 · 本机旅程'); await page.locator('[data-action=save-journey]').click();
  await expect(page.getByTestId('saved-title')).toHaveText('六景体验 · 本机旅程');
  const url = await page.getByLabel('此旅程专属网址').inputValue();
  await page.getByLabel('本机标签编号').fill('demo-tag-001'); await page.locator('[data-action=bind-tag]').click();
  const tagUrl = await page.getByLabel('本机标签网址').inputValue();
  const reopened = await context.newPage(); await page.close(); await reopened.goto(url);
  await expect(reopened.getByTestId('saved-title')).toHaveText('六景体验 · 本机旅程');
  await expect(reopened.getByTestId('map-element')).toHaveCount(6); await expect(reopened.locator('.dj-badge')).toContainText('非 GPS');
  await reopened.goto(tagUrl); await expect(reopened.getByTestId('saved-title')).toHaveText('六景体验 · 本机旅程');
  await reopened.goto('/preview/#/digital-jiaozi/journey?journeyId=missing'); await expect(reopened.getByRole('heading', { name:'当前浏览器暂无这段旅程' })).toBeVisible();
  await expect(reopened.getByTestId('saved-title')).toHaveCount(0);
  await reopened.goto('/preview/#/digital-jiaozi/journey?unknown=1'); await expect(reopened.getByRole('alert')).toContainText('参数');
  expect(errors).toEqual([]);
});

test('六张正式票图全部加载、完整比例、手机各视图可读且详情和导出使用同一素材', async ({page}) => {
  await page.goto(home); await nav(page,'collection');
  for (const landmark of LANDMARKS) {
    const image=page.locator(`.dj-ticket-art[data-id="${landmark.id}"] img`);
    await expect(image).toHaveAttribute('src',new RegExp(landmark.id + '\\.webp$'));
    expect(await image.evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(750);
    await expect(page.getByRole('heading',{name:landmark.name,exact:true})).toBeVisible();
  }
  await expect(page.locator('.dj-art-label')).toHaveText(Array(6).fill('地标交子'));
  await page.screenshot({path:'var/qa/formal-collection-375.png',fullPage:true});
  await page.locator('.dj-ticket-art[data-id=landmark-01]').click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('成都 IFS');
  await page.screenshot({path:'var/qa/formal-detail-375.png'});await page.getByLabel('关闭弹窗').click();
  for(const view of ['home','collection','rewards','journey','photos']) {
    await nav(page,view);
    for(const width of [320,375,430]) {await page.setViewportSize({width,height:812});await noOverflow(page);}
  }
  await page.setViewportSize({width:375,height:812});await collect(page);await nav(page,'home');
  await page.screenshot({path:'var/qa/formal-map-375.png',fullPage:true});
  const download=page.waitForEvent('download');await page.locator('[data-action=export]').click();
  await (await download).saveAs('var/qa/formal-six-memory.png');
  expect((await sharp('var/qa/formal-six-memory.png').metadata()).height).toBe(1800);
  await expect(page.locator('.dj-toast')).toContainText('纪念图已生成');
});

test('真实浏览器多标签并发打卡，重复点击不重复奖励；示例重置隔离个人', async ({page,context}) => {
  await page.goto(home); await nav(page, 'collection');
  const second = await context.newPage(); await second.goto('/preview/demo.html#/digital-jiaozi/collection');
  const button='[data-action=visit][data-id=landmark-01]';
  // Synchronous double dispatch is intentionally faster than disabling UI; IDB remains the guard.
  await Promise.all([page.locator(button).evaluate(el=>{ (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); }), second.locator(button).evaluate(el=>(el as HTMLButtonElement).click())]);
  await nav(page,'home'); await nav(second,'home');
  await expect(page.getByTestId('balance')).toHaveText('10'); await expect(second.getByTestId('balance')).toHaveText('10');
  await second.close();
  await page.goto('/preview/#/digital-jiaozi'); await expect(page.getByTestId('balance')).toHaveText('0');
  await page.goto(home); await expect(page.getByTestId('balance')).toHaveText('10');
  await page.locator('[data-action=reset-sample]').click();
  await expect(page.getByTestId('balance')).toHaveText('0'); await page.locator('[data-action=personal]').click();
  await expect(page.getByTestId('balance')).toHaveText('0');
});

test('独立60分兑换NFC后记忆完整，取消退分一次、领取终态', async ({page}) => {
  await page.goto(home); await collect(page); await nav(page,'rewards');
  await page.locator('[data-action=redeem][data-id=gift-nfc]').click(); await page.locator('[data-action=confirm-redeem]').click();
  await expect(page.getByTestId('balance')).toHaveText('0'); await page.locator('[data-action=cancel]').click();
  await expect(page.getByTestId('balance')).toHaveText('60'); await expect(page.locator('[data-action=cancel]')).toHaveCount(0);
  await page.locator('[data-action=redeem][data-id=gift-nfc]').click(); await page.locator('[data-action=confirm-redeem]').click();
  await page.locator('[data-action=receive]').click(); await expect(page.locator('[data-action=cancel]')).toHaveCount(0);
  await nav(page,'home'); await expect(page.getByTestId('balance')).toHaveText('0'); await expect(page.getByTestId('map-element')).toHaveCount(6);
});

test('真实照片上传、旋转、裁剪、三模式、预览Blob相同、关闭后恢复和导出', async ({page,context}) => {
  await page.goto('/preview/#/digital-jiaozi'); await nav(page,'photos');
  await page.locator('[data-photo-tools] summary').click();
  await page.getByLabel('选择相册照片',{exact:true}).setInputFiles({name:'asymmetric-fixture.png',mimeType:'image/png',buffer:await testPhoto()});
  await expect(page.locator('.dj-crop img')).toBeVisible();
  await page.locator('[data-rotate]').click();
  await page.getByLabel('照片缩放').fill('2');
  const crop=page.locator('.dj-crop'), rect=await crop.boundingBox();
  await page.mouse.move(rect!.x+100,rect!.y+100); await page.mouse.down(); await page.mouse.move(rect!.x+140,rect!.y+140,{steps:5}); await page.mouse.up();
  await page.getByLabel('照片名称',{exact:true}).fill('自己的双色照片');
  for (const mode of ['tone','outline','color']) { await page.getByLabel('图案模式').selectOption(mode); await page.locator('[data-preview]').click(); await expect(page.locator('[data-result]')).toBeVisible(); }
  const preview=await page.locator('.dj-photo-preview').evaluate(async(img)=>Array.from(new Uint8Array(await (await fetch((img as HTMLImageElement).src)).arrayBuffer())));
  await page.locator('[data-save]').click(); await expect(page.getByTestId('balance')).toHaveText('0');
  await page.locator('[data-action=page-next]').click(); await expect(page.getByTestId('map-element')).toHaveCount(1);
  const downloadPromise=page.waitForEvent('download'); await page.getByTestId('map-element').click(); const download=await downloadPromise;
  await download.saveAs('var/qa/photo-saved.png');
  const {readFile}=await import('node:fs/promises'); expect([...await readFile('var/qa/photo-saved.png')]).toEqual(preview);
  const metadata=await sharp(Buffer.from(preview)).metadata(); expect(metadata.width).toBe(512); expect(metadata.height).toBe(512);
  const stats=await sharp(Buffer.from(preview)).stats(); expect(stats.channels[0].stdev+stats.channels[2].stdev).toBeGreaterThan(20);
  await nav(page,'journey'); await page.locator('[data-action=save-journey]').click();
  const url=await page.getByLabel('此旅程专属网址').inputValue();
  const reopened=await context.newPage(); await page.close(); await reopened.goto(url); await reopened.locator('[data-action=page-next]').click();
  await expect(reopened.locator('[data-media-id]')).toHaveAttribute('src',/^blob:/);
  const exportPromise=reopened.waitForEvent('download'); await reopened.locator('[data-action=export-saved]').click();
  await (await exportPromise).saveAs('var/qa/memory-photo.png'); expect((await sharp('var/qa/memory-photo.png').metadata()).height).toBe(3600);
  await nav(reopened,'photos'); await expect(reopened.locator('[data-editor]')).toHaveCount(1); await expect(reopened.locator('[data-editor]')).toBeHidden();
  await reopened.screenshot({path:'var/qa/photos-375.png',fullPage:true});
  // Missing stored media has visible fallback and still permits export.
  await reopened.evaluate(async()=>{await new Promise<void>((resolve,reject)=>{ const r=indexedDB.open('digital-jiaozi:personal');r.onsuccess=()=>{const db=r.result,t=db.transaction('media','readwrite');t.objectStore('media').clear();t.oncomplete=()=>{db.close();resolve()};t.onabort=()=>reject(t.error)}})});
  await reopened.reload(); await expect(reopened.locator('[data-media-id]')).toHaveAttribute('data-fallback','true');
});

test('换图manifest、宿主接口、内存路由隔离、缺图回退及导出', async ({page}) => {
  const fixture=await testPhoto();
  await page.route('**/fixture-art.png',route=>route.fulfill({contentType:'image/png',body:fixture}));
  await page.goto('/host-fixture.html#team-route'); await page.waitForFunction(()=>(window as any).ready);
  await page.evaluate(async(activity)=>{ const api=(window as any).dj,j=await api.getContext(); const e={eventId:'host-event-1',activityId:activity,placeId:'host-place-1',journeyId:j.id,occurredAt:'2026-10-31T09:00:00Z'}; await api.acceptCheckin(e);await api.acceptCheckin(e); },ACTIVITY.id);
  await expect(page.getByTestId('balance')).toHaveText('10'); await expect(page.locator('.dj-map img')).toHaveAttribute('src',/fixture-art.png/);
  await expect(page.locator('.dj-map img')).toHaveCSS('object-fit','cover'); await noOverflow(page);
  const downloadPromise=page.waitForEvent('download'); await page.locator('[data-action=export]').click();await (await downloadPromise).saveAs('var/qa/manifest-replacement.png');
  const {data}=await sharp('var/qa/manifest-replacement.png').extract({left:320,top:400,width:1,height:1}).raw().toBuffer({resolveWithObject:true}); expect(data[2]).toBeGreaterThan(data[0]);
  await nav(page,'journey'); await page.locator('[data-action=host-route]').click(); expect(await page.evaluate(()=>(window as any).hostRouteCalls)).toBe(1);
  await page.locator('[data-action=save-journey]').click(); await expect(page.getByTestId('saved-title')).toBeVisible();
  await page.locator('[data-action=open-saved]').click(); await expect(page.getByTestId('saved-title')).toBeVisible(); expect(new URL(page.url()).hash).toBe('#team-route');
  await expect(page.locator('#host-owned')).toHaveText('宿主区域');
  await page.unroute('**/fixture-art.png');await page.route('**/fixture-art.png',route=>route.fulfill({status:404,body:'missing'}));
  await page.reload();await page.waitForFunction(()=>(window as any).ready); await expect(page.locator('.dj-map img')).toHaveAttribute('data-fallback','true');
  const fallback=page.waitForEvent('download'); await page.locator('[data-action=export]').click(); await (await fallback).saveAs('var/qa/missing-art.png');
  await expect(page.locator('.dj-toast')).toContainText('缺失资源');
});

test('存储中途失败显示真实错误，余额和图案均不假成功；未知未来版本保留', async ({page}) => {
  await page.addInitScript(()=>{ const original=IDBObjectStore.prototype.add; IDBObjectStore.prototype.add=function(...args: Parameters<typeof original>){if(this.name==='ledger') throw new DOMException('测试存储空间不足','QuotaExceededError'); return original.apply(this,args)}; });
  await page.goto(home);await nav(page,'collection');await page.locator('[data-action=visit][data-id=landmark-01]').click();
  await expect(page.locator('.dj-toast')).toContainText('存储空间不足');await nav(page,'home');await expect(page.getByTestId('balance')).toHaveText('0');await expect(page.getByTestId('map-element')).toHaveCount(0);
  await page.evaluate(async()=>{await new Promise<void>((resolve)=>{ const r=indexedDB.open('digital-jiaozi:sample',3);r.onupgradeneeded=()=>r.result.createObjectStore('future-records').add('preserved', 'future');r.onsuccess=()=>{r.result.close();resolve()} })});
  await page.reload();await expect(page.getByRole('heading',{name:'暂时无法打开本地交子档案'})).toBeVisible();await expect(page.locator('.dj-fatal')).toContainText('原记录未删除');
  expect(await page.evaluate(async()=>await new Promise(resolve=>{const r=indexedDB.open('digital-jiaozi:sample',3);r.onsuccess=()=>{const db=r.result,tx=db.transaction('future-records'),q=tx.objectStore('future-records').get('future');q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>db.close()}}))).toBe('preserved');
});
