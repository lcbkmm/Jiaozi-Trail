import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerCenter, playerAvatarMarkup, playerStateView } from '../game-map-player.mjs';

class Element extends EventTarget {
  constructor(doc) { super(); this.doc = doc; this.children = []; this.attributes = {}; this.isConnected = true; this.html = ''; }
  append(child) { this.children.push(child); } remove() { this.isConnected = false; }
  setAttribute(key,value) { this.attributes[key] = value; }
  set innerHTML(value) { this.html = value; } get innerHTML() { return this.html; }
  querySelector() { return { focus() {} }; }
  focus() { this.doc.activeElement = this; } showModal() { this.open = true; } close() { this.open = false; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const account = (balance = 30) => ({ wallet: { balance, earned: 40 }, claims: [{ id:'one',source:'demo',order:1,occurredAt:'2026-11-01T10:00:00+08:00',place:{name:'成都 IFS'} }], ledger:[{id:'earned',kind:'earn',amount:10,title:'地标奖励',createdAt:'2026-11-01T10:00:00+08:00'}], journeys:[], redemptions:[] });
function harness({ getState, onAction } = {}) {
  const doc = {}; doc.body = new Element(doc); const stage = new Element(doc), initialFocus = new Element(doc); doc.activeElement = initialFocus;
  doc.getElementById = key => key === 'stage' ? stage : null; doc.createElement = () => new Element(doc);
  const changes = [], actions = [];
  const center = createPlayerCenter({ host:{document:doc}, profile:{name:'旅人'}, getState, onOpenChange:v => changes.push(v), onAction: onAction || ((action,payload) => actions.push({action,payload})) });
  const card = stage.children[0], dialog = doc.body.children[0];
  function click(action, other = {}) { const target = { disabled:false, dataset:{playerAction:action,...other} }; const event = new Event('click'); Object.defineProperty(event,'target',{value:{closest:()=>target}}); dialog.dispatchEvent(event); }
  return { center, doc, changes, actions, card, dialog, click, initialFocus };
}

test('unknown wallet is not fabricated, avatar inputs cannot inject remote images or markup', () => {
  const state = playerStateView({wallet:{balance:-5,earned:1}}); assert.equal(state.ready,false); assert.equal(state.balance,null);
  const markup = playerAvatarMarkup({photoDataUrl:'https://example.com/tracker.svg',outfitColor:'red" onload="alert(1)'});
  assert.ok(!markup.includes('tracker')); assert.ok(!markup.includes('onload')); assert.match(markup,/<svg/);
  const h = harness(); assert.match(h.card.innerHTML,/—/); h.center.updateProfile({name:'<img src=x onerror=alert(1)>'}); assert.ok(!h.card.innerHTML.includes('<img')); h.center.destroy();
});

test('card opens full personal center and all panels retain real shared state/source', () => {
  const h = harness(); h.center.updateState(account()); h.center.open();
  assert.match(h.dialog.innerHTML,/我的装扮/); assert.match(h.dialog.innerHTML,/30/); assert.deepEqual(h.changes,[true]);
  h.click('tab-wallet'); assert.match(h.dialog.innerHTML,/地标奖励/); assert.match(h.dialog.innerHTML,/\+10/);
  h.click('tab-visits'); assert.match(h.dialog.innerHTML,/成都 IFS/); assert.match(h.dialog.innerHTML,/试玩记录 · 非位置验证/);
  h.center.updateState({...account(),sample:true}); assert.match(h.card.innerHTML,/示例/);
  h.center.close(); assert.equal(h.doc.activeElement,h.initialFocus); assert.deepEqual(h.changes,[true,false]);
  h.center.destroy(); assert.equal(h.card.isConnected,false); assert.equal(h.dialog.isConnected,false); h.center.open(); assert.equal(h.center.isOpen(),false);
});

test('navigation closes personal modal before opening original game functionality', async () => {
  const seen = [];
  const h = harness({ onAction:(action,payload) => { seen.push({action,payload,isOpen:h.center.isOpen()}); } });
  h.center.open(); h.click('open-avatar'); await tick();
  assert.deepEqual(seen[0],{action:'open-avatar',payload:undefined,isOpen:false});
  h.center.open('visits'); h.click('open-jiaozi',{playerView:'collection'}); await tick();
  assert.deepEqual(seen[1],{action:'open-jiaozi',payload:{view:'collection'},isOpen:false}); h.center.destroy();
});

test('gift confirmation calls only shared transaction once, uses returned balance and orders', async () => {
  let resolve, count = 0;
  const h = harness({onAction:(action,payload) => { assert.equal(action,'redeem'); assert.deepEqual(payload,{giftId:'gift-charm'}); count++; return new Promise(r=>resolve=r); }});
  h.center.updateState(account(30)); h.center.open('gifts'); h.click('select-gift',{playerGift:'gift-charm'});
  assert.match(h.dialog.innerHTML,/确认兑换/); assert.equal(count,0,'selection must not spend'); h.click('confirm-gift'); h.click('confirm-gift');
  assert.equal(count,1); assert.equal(h.center.isOpen(),true);
  resolve({state:{...account(10),redemptions:[{id:'order',title:'胸章 / 小挂件',cost:20,status:'pending'}]},message:'兑换成功'}); await tick();
  assert.match(h.card.innerHTML,/<b>10<\/b>/); assert.match(h.dialog.innerHTML,/待领取 · 试玩/); assert.match(h.dialog.innerHTML,/兑换成功/); h.center.destroy();
});

test('insufficient balance and failed exchange never invent deductions or orders', async () => {
  let count=0;
  const h = harness({onAction:()=>{count++;throw Error('余额已变化，请刷新核对');}}); h.center.updateState(account(0)); h.center.open('gifts'); h.click('select-gift',{playerGift:'gift-charm'}); h.click('confirm-gift');
  assert.equal(count,0); h.center.updateState(account(30)); h.click('select-gift',{playerGift:'gift-charm'}); h.click('confirm-gift'); await tick();
  assert.equal(count,1); assert.match(h.dialog.innerHTML,/余额已变化/); assert.match(h.card.innerHTML,/<b>30<\/b>/); assert.ok(!h.dialog.innerHTML.includes('待领取 · 试玩')); h.center.destroy();
});

test('late getState cannot overwrite a newer pushed wallet or a destroyed panel', async () => {
  const requests=[];
  const h = harness({getState:()=>new Promise(resolve=>requests.push(resolve))}); h.center.open('wallet');
  h.center.updateState(account(40)); requests[0](account(0)); requests[1](account(5)); await tick();
  assert.match(h.card.innerHTML,/<b>40<\/b>/);
  h.center.open('wallet'); h.center.destroy(); requests[2](account(60)); await tick(); assert.equal(h.center.isOpen(),false);
});

test('merchant and landmark visits share a deduplicated count and retain clear sources', () => {
  const input = { ...account(50),demo:true,merchantCheckins:[{id:'merchant-visit',merchantId:'coffee',placeName:'街角咖啡',occurredAt:'2026-11-01T13:00:00+08:00',source:'demo',amount:10},{id:'one',source:'demo'}] };
  const view = playerStateView(input); assert.equal(view.visits.length,2); assert.equal(view.claims.length,1); assert.equal(view.merchantCheckins.length,2);
  const h=harness();h.center.updateState(input);h.center.open('visits');assert.match(h.card.innerHTML,/2 次到访/);assert.match(h.dialog.innerHTML,/街角咖啡/);assert.match(h.dialog.innerHTML,/商家打卡/);assert.match(h.dialog.innerHTML,/六景收藏/);assert.match(h.dialog.innerHTML,/不用于线下结算/);h.center.destroy();
});

test('cancel refund requires confirmation and updates only through the same ledger transaction', async () => {
  const calls=[], pending={id:'order-one',title:'小挂件',cost:20,status:'pending'};
  const h=harness({onAction:async(action,payload)=>{calls.push({action,payload});return {...account(50),demo:true,redemptions:[{...pending,status:'cancelled'}]};}});
  h.center.updateState({...account(30),redemptions:[pending],demo:true});h.center.open('gifts');h.click('select-cancel-order',{playerOrder:'order-one'});assert.equal(calls.length,0);assert.match(h.dialog.innerHTML,/确认取消并退回/);
  h.click('confirm-cancel-order');await tick();assert.deepEqual(calls,[{action:'cancel-redemption',payload:{id:'order-one'}}]);assert.match(h.card.innerHTML,/<b>50<\/b>/);assert.match(h.dialog.innerHTML,/已取消并退回交子/);assert.equal(h.center.isOpen(),true);h.center.destroy();
});

test('demo receiving calls the original pending order and never allows replay of a finished order', async () => {
  const calls=[],order={id:'order-one',title:'熊猫玩偶',cost:50,status:'pending'};
  const h=harness({onAction:async(action,payload)=>{calls.push({action,payload});return{...account(0),redemptions:[{...order,status:'received'}]};}});
  h.center.updateState({...account(0),redemptions:[order]});h.center.open('gifts');h.click('receive-order',{playerOrder:'order-one'});await tick();h.click('receive-order',{playerOrder:'order-one'});await tick();
  assert.deepEqual(calls,[{action:'receive-demo-redemption',payload:{id:'order-one'}}]);assert.match(h.dialog.innerHTML,/已试玩领取/);h.center.destroy();
});
