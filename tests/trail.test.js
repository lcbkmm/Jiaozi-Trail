const test = require('node:test');
const assert = require('node:assert/strict');
const { planTrail, stampPlace, walletState } = require('../miniprogram/utils/trail');

test('默认路线包含三个品类，且总花费和完整行程均符合约束', () => {
  const route = planTrail({ budget: 300, duration: 240, interests: ['美妆首发', '咖啡甜点', '城市好物'] });
  assert.equal(route.stops.length, 3);
  assert.equal(new Set(route.stops.map((place) => place.category)).size, 3);
  assert.ok(route.cost <= 300);
  assert.ok(route.minutes <= 240);
  assert.equal(route.minutes, route.stops.reduce((sum, place) => sum + place.walk + place.queue + place.stay, 0));
});

test('零预算保留免费点位；极短时间和无效输入没有可行路线', () => {
  const route = planTrail({ budget: 0, duration: 120 });
  assert.equal(route.cost, 0);
  assert.ok(route.stops.every((place) => place.cost === 0));
  assert.equal(planTrail({ budget: 300, duration: 1 }), null);
  assert.equal(planTrail({ budget: -1, duration: 120 }), null);
  assert.equal(planTrail({ budget: 300, duration: NaN }), null);
});

test('重复打卡不增加足迹，联动交子要求三个品类而非任意三店', () => {
  let stamps = stampPlace([], 'books');
  stamps = stampPlace(stamps, 'books');
  stamps = stampPlace(stamps, 'design');
  stamps = stampPlace(stamps, 'gallery');
  assert.equal(stamps.length, 3);
  assert.equal(walletState(stamps).level, '进阶交子');
  stamps = stampPlace(stampPlace(stamps, 'beauty'), 'coffee');
  assert.equal(walletState(stamps).level, '联动交子');
  assert.equal(walletState(stamps).progress, 100);
  assert.deepEqual(stampPlace(stamps, 'unknown'), stamps);
});
