const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const pagePath = path.join(root, 'miniprogram/pages/explore/index.js');
const storage = new Map();
const notices = [];
let definition;
const context = {
  require: createRequire(pagePath),
  Page(value) { definition = value; },
  getApp() { return { globalData: { apiBase: 'http://127.0.0.1:8004' } }; },
  wx: {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    showToast(value) { notices.push(value); },
    showModal(value) { notices.push(value); },
    request(options) {
      fetch(options.url, {
        method: options.method,
        headers: options.header,
        body: options.data === undefined ? undefined : JSON.stringify(options.data)
      }).then(async response => options.success({statusCode: response.status, data: await response.json()}))
        .catch(() => options.fail());
    }
  },
  console
};
vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), context, { filename: pagePath });
const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) });
page.setData = patch => Object.assign(page.data, patch);
(async () => {
  page.onLoad();
  assert.ok(page.data.options.length >= 1 && page.data.options.length <= 3);
  assert.equal(page.data.online, false);
  assert.ok(page.data.markers.length > 0);
  assert.ok(page.data.polylines.every(line => line.points.length > 1));
  page.data.durationIndex = 0;
  await page.generate();
  assert.ok(notices.some(n => n.title === '需要连接后端'));
  page.data.durationIndex = 2;
  const id = page.data.options[page.data.options.length - 1].option_id;
  page.chooseOption({ currentTarget: { dataset: { id } } });
  assert.equal(page.data.selectedId, id);
  await page.openPlace('ifs');
  assert.equal(page.data.detail.crowd_density.value, null);
  assert.ok(page.data.detail.queueLabel.includes('演示'));
  page.closeDetail();
  assert.equal(page.data.detail, null);
  await page.startRoute();
  assert.equal(page.data.routeStatus, 'active');
  assert.ok(notices.some(n => n.title.includes('未写入后端')));
  const offline = { options: page.data.options.length, mapPaths: page.data.polylines.length, controls: 'passed' };
  if (process.argv.includes('--live')) {
    await page.connect();
    assert.equal(page.data.online, true);
    const chosen = page.data.options[page.data.options.length - 1].option_id;
    page.chooseOption({ currentTarget: { dataset: { id: chosen } } });
    await page.startRoute();
    assert.equal(page.data.routeStatus, 'active');
    assert.ok(page.savedRoute.route_id);
    assert.equal(page.savedRoute.status, 'active');
    assert.equal(page.savedRoute.preferences.planning_style, chosen);
    assert.ok(storage.has('jiaozi-mini-last-route'));
  }
  // The adapter below tests initial-plan confirmation only; dynamic flow has its own live script.
  page.savedRoute = null; page.data.routeStatus = 'planned';
  page.data.online = true;
  page.data.chatText = '预算改成90元';
  const routeBefore = page.data.route;
  const actualRequest = page.request;
  page.request = async function(url) {
    assert.equal(url, '/api/v1/chat');
    return {data:{status:'proposal', reply:'测试适配器的建议，并非真实模型', context_revision:1,
      preferences:Object.assign({},routeBefore.preferences,{budget_per_person_fen:9000}),
      route_options:[Object.assign({},routeBefore,{option_id:'balanced',title:'测试方案',recommended:true,
        preferences:Object.assign({},routeBefore.preferences,{budget_per_person_fen:9000})})]}};
  };
  await page.sendChat();
  assert.equal(page.data.route, routeBefore);
  assert.ok(page.data.chatPending);
  await page.applyChatProposal();
  assert.equal(page.data.budget,'90');
  assert.equal(page.data.route.preferences.budget_per_person_fen,9000);
  assert.equal(page.data.chatPending,null);
  page.data.chatText='换个方案';
  page.request=async function(){throw new Error('MODEL_UNAVAILABLE: test-adapter');};
  const beforeFailure=page.data.route;
  await page.sendChat();
  assert.equal(page.data.route,beforeFailure);
  assert.ok(page.data.chatNotice.includes('未执行本次修改'));
  page.request=actualRequest;
  console.log(JSON.stringify({ offline, liveApi: process.argv.includes('--live') ? 'passed' : 'not_requested',
    chatConfirmationAndFailure: 'passed with explicit test adapter, not language accuracy',
    runtime: 'Node with wx API adapter; not an IDE or real-device visual test' }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
