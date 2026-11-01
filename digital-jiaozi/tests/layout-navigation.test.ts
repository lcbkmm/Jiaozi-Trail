import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, journeyUrl, mapReturnUrl } from '../src/domain/navigation.ts';
import { geometry, fitImage, fitTitle } from '../src/media/layout.ts';
import { initial, normalized, zoom, clamp } from '../src/media/crop.ts';

test('独立交子入口可直接返回同源地图，并保留部署子路径', () => {
  for (const entry of ['index.html', '']) {
    for (const route of ['', '#/digital-jiaozi/photos', '?from=nfc#/digital-jiaozi/journey?tagId=one']) {
      assert.equal(mapReturnUrl(`http://127.0.0.1:8765/assets/digital-jiaozi/${entry}${route}`), 'http://127.0.0.1:8765/baidu-map.html');
      assert.equal(mapReturnUrl(`https://example.org/demo/assets/digital-jiaozi/${entry}${route}`), 'https://example.org/demo/baidu-map.html');
    }
  }
  assert.equal(mapReturnUrl('http://localhost:5173/#/digital-jiaozi'), undefined);
  assert.equal(mapReturnUrl('https://example.org/digital-jiaozi/index.html'), undefined);
});

test('NFC URL 保留部署子路径，显式参数与错误路由有独立状态', () => {
  const url = journeyUrl('https://example.org/team/demo/?site=1#old', { journeyId: 'journey-1' });
  assert.equal(new URL(url).pathname, '/team/demo/');
  assert.equal(parseRoute(new URL(url).hash).journeyId, 'journey-1');
  assert.equal(parseRoute('#/digital-jiaozi/journey').view, 'journey');
  for (const hash of ['#/digital-jiaozi/journey?x=y', '#/digital-jiaozi/journey?journeyId=', '#/digital-jiaozi/journey?tagId=a&tagId=b', '#/digital-jiaozi/nope']) assert.ok(parseRoute(hash).error, hash);
});

test('页面/导出共用六格几何，contain/cover/position 不拉伸，长标题截断', () => {
  const slots = geometry(1200); assert.equal(slots.length, 6);
  assert.equal(slots[0].y, slots[1].y); assert.ok(slots[2].y > slots[0].y);
  assert.ok(slots.every(s => s.x + s.width < 1200 && s.y + s.height < 1800));
  assert.deepEqual(fitImage(400, 200, 0, 0, 100, 100, 'contain'), { x: 0, y: 25, w: 100, h: 50 });
  assert.deepEqual(fitImage(400, 200, 0, 0, 100, 100, 'cover', '100% 50%'), { x: -100, y: 0, w: 200, h: 100 });
  assert.equal(fitTitle('123456789', 5, s => s.length), '1234…');
});

test('横竖图裁剪及连续缩放始终在原图边界内，拖动实际改变取样区域', () => {
  for (const [w, h] of [[1600, 800], [800, 1600], [1024, 1024]]) {
    let crop = initial(w, h, 300);
    for (const amount of [1.5, 2, .7, .2, 10]) {
      crop = clamp({ ...zoom(crop, amount), left: -10000, top: 9999 });
      const n = normalized(crop), side = Math.min(w, h) * n.size;
      assert.ok(n.x >= 0 && n.y >= 0 && n.x * w + side <= w + .01 && n.y * h + side <= h + .01);
    }
  }
  const start = initial(1600, 800, 300);
  assert.notEqual(normalized(start).x, normalized(clamp({ ...start, left: 0 })).x);
});
