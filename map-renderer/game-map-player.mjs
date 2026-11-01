import { normalizeAvatarProfile } from './game-map-avatar.mjs';

const TABS = { traveler: '我的旅人', wallet: '交子钱包', visits: '到访记录', gifts: '旅途礼品' };
const GIFTS = Object.freeze([
  { id: 'gift-charm', title: '胸章 / 小挂件', cost: 20, symbol: '✦', description: '一件可以随身携带的小记忆' },
  { id: 'gift-magnet', title: '普通主题冰箱贴', cost: 30, symbol: '▧', description: '把旅行的一角带回日常' },
  { id: 'gift-keepsake', title: '纪念小物', cost: 40, symbol: '◇', description: '留给这次出发的纪念' },
  { id: 'gift-panda', title: '熊猫玩偶', cost: 50, symbol: '◕', description: '陪伴旅程的软绵绵伙伴' },
  { id: 'gift-nfc', title: 'NFC 实体纪念交子冰箱贴', cost: 60, symbol: '⌁', description: '轻碰纪念交子，打开本地旅程入口' },
]);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const array = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const unwrap = value => value?.state ? { ...value.state, sample: value.sample ?? value.state.sample } : value;
const date = value => { const timestamp = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp) : '时间未记录'; };

export function playerStateView(value) {
  const raw = value && typeof value === 'object' ? value : {}, wallet = raw.wallet;
  const balance = integer(wallet?.balance), earned = integer(wallet?.earned);
  const claims = array(raw.claims), merchantCheckins = array(raw.merchantCheckins), seen = new Set();
  const visits = [...claims.map(item => ({ ...item, visitKind: 'landmark' })), ...merchantCheckins.map(item => ({ ...item, visitKind: 'merchant' }))].filter(item => {
    const key = item.eventId || item.id; if (!key) return true; if (seen.has(key)) return false; seen.add(key); return true;
  });
  const gifts = array(raw.gifts).filter(item => typeof item.id === 'string' && /^[\w-]{1,80}$/.test(item.id) && integer(item.cost) > 0).map(item => ({ id: item.id, cost: item.cost, title: String(item.title || '旅途纪念').slice(0,120), symbol: String(item.symbol || '◇').slice(0,4), description: String(item.description || '').slice(0,300) }));
  return { ...raw, balance, earned, ready: balance !== null && earned !== null, claims, merchantCheckins, visits, gifts: gifts.length ? gifts : GIFTS, ledger: array(raw.ledger), redemptions: array(raw.redemptions), journeys: array(raw.journeys), sample: raw.sample === true, demo: raw.demo === true };
}

export function playerAvatarMarkup(value) {
  const profile = normalizeAvatarProfile(value), { skinColor: skin, hairColor: hair, outfitColor: outfit, accentColor: accent } = profile;
  const face = profile.photoDataUrl ? `<image href="${escape(profile.photoDataUrl)}" x="25" y="19" width="50" height="52" preserveAspectRatio="xMidYMid slice" clip-path="url(#player-face-clip)"/>` : `<ellipse cx="40" cy="45" rx="2.6" ry="3.5" fill="#363239"/><ellipse cx="60" cy="45" rx="2.6" ry="3.5" fill="#363239"/><ellipse cx="34" cy="54" rx="5" ry="2.5" fill="#e69e9499"/><ellipse cx="66" cy="54" rx="5" ry="2.5" fill="#e69e9499"/><path d="M44 57 Q50 63 56 57" stroke="#a36e63" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs><clipPath id="player-face-clip"><ellipse cx="50" cy="45" rx="24" ry="26"/></clipPath></defs><circle cx="50" cy="50" r="49" fill="#e7eedc"/><path d="M13 100 Q15 72 39 72 L61 72 Q85 72 88 100" fill="${outfit}"/><path d="M44 74 L56 74 L59 100 L41 100Z" fill="#fff8e7"/><path d="M41 67 H59 V78 Q50 86 41 78Z" fill="${skin}"/>${profile.hairStyle === 'bob' ? `<path d="M20 40 Q18 10 49 10 Q81 10 80 45 L83 72 Q70 79 61 68 H35 Q23 76 18 67Z" fill="${hair}"/>` : ''}<ellipse cx="50" cy="37" rx="30" ry="29" fill="${hair}"/><ellipse cx="50" cy="46" rx="25" ry="28" fill="${skin}"/>${face}<path d="M24 36 Q20 11 47 11 Q76 8 79 34 Q66 31 59 23 Q47 37 24 36Z" fill="${hair}"/><path d="M26 30 Q22 42 25 49 L20 45 L20 31Z M74 29 Q79 38 75 50 L81 45 L80 29Z" fill="${hair}"/><circle cx="73" cy="89" r="5" fill="${accent}"/></svg>`;
}

export function createPlayerCenter({ host = window, profile: initialProfile, getState, onAction, onOpenChange } = {}) {
  const doc = host.document, stage = doc.getElementById('stage') || doc.body;
  let profile = normalizeAvatarProfile(initialProfile), state = playerStateView(null), opened = false, destroyed = false, tab = 'traveler', previousFocus, refreshSequence = 0, actionSequence = 0, busy = false, confirmation, cancelOrder, notice = '', noticeError = false;
  const card = doc.createElement('button'); card.id = 'map-player-card'; card.className = 'player-card'; card.type = 'button'; card.setAttribute('aria-haspopup', 'dialog'); card.setAttribute('aria-controls', 'map-player-center'); card.setAttribute('aria-expanded', 'false'); stage.append(card);
  const dialog = doc.createElement('dialog'); dialog.id = 'map-player-center'; dialog.className = 'player-center'; dialog.setAttribute('aria-labelledby', 'player-center-title'); doc.body.append(dialog);
  function drawCard() {
    card.innerHTML = `<span class="player-card-face">${playerAvatarMarkup(profile)}</span><span class="player-card-copy"><strong>${escape(profile.name)}</strong><small>${state.sample ? '示例 · ' : state.demo ? '试玩 · ' : ''}<b>${state.ready ? state.balance : '—'}</b> 枚交子 <i>·</i> ${state.ready ? state.visits.length : '—'} 次到访</small></span><span class="player-card-arrow" aria-hidden="true">›</span>`;
    card.setAttribute('aria-label', `${profile.name}，${state.ready ? `${state.balance}枚交子，${state.visits.length}次到访` : '档案同步中'}，打开个人中心`);
  }
  const button = (action, label, more = '') => `<button type="button" data-player-action="${action}" ${more}>${label}</button>`;
  const empty = (text, action, label) => `<div class="player-empty"><span aria-hidden="true">✧</span><p>${escape(text)}</p>${action ? button(action, escape(label)) : ''}</div>`;
  function traveler() {
    return `<section class="player-identity"><div class="player-large-face">${playerAvatarMarkup(profile)}</div><div><p class="player-kicker">CHUNXI EXPLORER</p><h3>${escape(profile.name)}</h3><p>把今天走过的街角，变成你的故事。</p><span class="player-source">${state.sample ? '独立示例档案' : '本机个人档案'} · 春熙路篇</span></div></section>
      <div class="player-stats"><div><b>${state.ready ? state.balance : '—'}</b><span>可用交子 · 枚</span></div><div><b>${state.ready ? state.visits.length : '—'}</b><span>已记录到访</span></div><div><b>${state.ready ? state.journeys.length : '—'}</b><span>旅程记录</span></div></div>
      ${state.demo ? '<p class="player-demo-wallet">试玩钱包 · 不用于线下结算</p>' : ''}<div class="player-action-grid">${button('open-avatar', '<span>✿</span><strong>我的装扮</strong><small>照片卡通头像 · 发型与配色</small>')}${button('focus-avatar', '<span>⌖</span><strong>看看我的角色</strong><small>近看地图里的旅行伙伴</small>')}${button('open-checkin', '<span>✦</span><strong>商家打卡</strong><small>选择商家，试玩领取交子</small>')}${button('open-planner', '<span>⌁</span><strong>计划下一站</strong><small>在路线工坊安排今天的行程</small>')}</div>
      <section class="player-memory-strip"><div><h3>旅行不只有坐标</h3><p>收藏交子、照片与路上的回忆</p></div>${button('open-jiaozi', '旅程纪念 →', 'data-player-view="journey"')}</section><p class="player-footnote">地图点亮是本地探索标记；模拟漫游不会自动形成打卡、交子或真实 GPS 行程。</p>`;
  }
  function wallet() {
    return `<section class="player-wallet-balance"><span>我的交子</span><strong>${state.ready ? state.balance : '—'}<small> 枚</small></strong><p>累计获得 ${state.ready ? state.earned : '—'} 枚 · 收藏与回忆始终保留</p>${button('tab-gifts', '去挑一份旅行纪念 →')}</section>${state.demo ? '<p class="player-demo-wallet">试玩钱包 · 不用于线下结算</p>' : ''}<section class="player-section"><div class="player-section-heading"><h3>交子流水</h3><span>与数字交子同步</span></div>${state.ledger.length ? `<ol class="player-ledger">${state.ledger.slice().sort((a,b) => (Date.parse(b.createdAt)||0) - (Date.parse(a.createdAt)||0)).map(item => { const amount = Number.isSafeInteger(item.amount) ? item.amount : 0; return `<li><div><strong>${escape(item.title)}</strong><small>${escape(date(item.createdAt))} · ${item.kind === 'earn' ? '到访发放' : item.kind === 'refund' ? '取消退回' : '礼品兑换'}</small></div><b class="${amount >= 0 ? 'is-positive' : ''}">${amount > 0 ? '+' : ''}${amount} 枚</b></li>`; }).join('')}</ol>` : empty(state.ready ? '从第一家商店开始，攒下一点点旅行的惊喜。' : '正在读取交子账本。', 'open-checkin', '去商家打卡')}</section><p class="player-footnote">${state.sample ? '当前为独立示例档案。' : '余额来自本机数字交子账本。'}试玩发放与领取不代表线下核销。</p>`;
  }
  function visits() {
    const claims = state.visits.slice().sort((a,b) => (Date.parse(b.occurredAt)||0) - (Date.parse(a.occurredAt)||0));
    return `<div class="player-section-heading"><div><h3>走过的地方，都会留下印记</h3><p>${claims.length} 次到访 · ${claims.filter(item => item.visitKind === 'merchant').length} 次商家打卡</p></div>${button('open-checkin', '商家打卡')}</div>${claims.length ? `<ol class="player-visits">${claims.map((claim, index) => `<li><span class="player-visit-mark">${String(integer(claim.order) || claims.length - index).padStart(2,'0')}</span><div><h3>${escape(claim.visitKind === 'merchant' ? claim.placeName || claim.merchantName || claim.name || '商家到访' : claim.place?.name || '地标到访')}</h3><p>${escape(date(claim.occurredAt))}</p><span class="player-claim-source ${claim.source === 'demo' ? 'is-demo' : ''}">${claim.visitKind === 'merchant' ? '商家打卡' : '六景收藏'} · ${claim.source === 'demo' ? '试玩记录 · 非位置验证' : '接入打卡记录'}</span></div>${claim.visitKind === 'merchant' ? '<span class="player-visit-award">+' + (integer(claim.amount) ?? 0) + ' 枚</span>' : button('open-jiaozi','查看交子','data-player-view="collection"')}</li>`).join('')}</ol>` : empty(state.ready ? '这里还没有到访记录。选择一家商店，试玩领取交子。' : '正在同步到访记录。','open-checkin','打开商家打卡')}<div class="player-inline-actions">${button('open-jiaozi','六景交子收藏 →','data-player-view="collection"')}${button('open-jiaozi','照片记忆 →','data-player-view="photos"')}</div><p class="player-footnote">六景收藏与商家打卡都读取同一数字交子档案。地图点亮与移动小人不会自动生成到访。${state.demo ? '试玩钱包 · 不用于线下结算。' : ''}</p>`;
  }
  function gifts() {
    return `<div class="player-section-heading"><div><h3>给旅行留一份纪念</h3><p>可用 ${state.ready ? state.balance : '—'} 枚交子</p></div><span class="player-source">试玩礼品兑换</span></div><div class="player-gifts">${state.gifts.map(gift => { const available = state.ready && state.balance >= gift.cost; return `<article><span class="player-gift-symbol" aria-hidden="true">${escape(gift.symbol)}</span><div><h3>${escape(gift.title)}</h3><p>${escape(gift.description)}</p><strong>${gift.cost} 枚</strong><small>${!state.ready ? '账本同步中' : available ? `兑换后剩余 ${state.balance - gift.cost} 枚` : `还差 ${gift.cost - state.balance} 枚`}</small></div>${button('select-gift','兑换',`data-player-gift="${escape(gift.id)}" ${!available || busy ? 'disabled' : ''}`)}</article>`; }).join('')}</div>${confirmation ? `<section class="player-gift-confirm" role="group" aria-label="确认礼品兑换"><p>使用 <strong>${confirmation.cost} 枚</strong>兑换「${escape(confirmation.title)}」？会从同一个交子钱包扣除交子。</p><div>${button('cancel-gift','暂不兑换')}${button('confirm-gift',busy ? '提交中…' : '确认兑换',busy ? 'disabled' : '')}</div></section>` : ''}<section class="player-section"><h3>兑换记录</h3>${state.redemptions.length ? `<ol class="player-orders">${state.redemptions.slice().reverse().map(order => `<li><div><strong>${escape(order.title)}</strong><small>${escape(date(order.createdAt))} · ${integer(order.cost) ?? '—'} 枚</small><span class="player-order-status">${order.status === 'cancelled' ? '已取消并退回交子' : order.status === 'received' ? '已试玩领取' : '待领取 · 试玩'}</span></div>${order.status === 'pending' ? `<div class="player-order-actions">${button('receive-order','试玩领取',`data-player-order="${escape(order.id)}" ${busy ? 'disabled' : ''}`)}${button('select-cancel-order','取消并退回',`data-player-order="${escape(order.id)}" ${busy ? 'disabled' : ''}`)}</div>` : ''}</li>`).join('')}</ol>` : '<p class="player-muted">还没有兑换记录，收藏好你的每一次出发。</p>'}</section>${cancelOrder ? `<section class="player-gift-confirm" role="group" aria-label="确认取消兑换"><p>取消「${escape(cancelOrder.title)}」，将 <strong>${integer(cancelOrder.cost) ?? 0} 枚</strong>交子退回同一钱包？</p><div>${button('dismiss-cancel-order','保留礼品')}${button('confirm-cancel-order',busy ? '提交中…' : '确认取消并退回',busy ? 'disabled' : '')}</div></section>` : ''}<p class="player-footnote">兑换、试玩领取与退回共用数字交子的原有账本。试玩钱包 · 不用于线下结算；当前不代表实际礼品库存或商户核销。</p>`;
  }
  function drawDialog() {
    if (!opened || destroyed) return;
    dialog.innerHTML = `<header class="player-center-heading"><div><p class="player-kicker">交子漫游 · 旅人档案</p><h2 id="player-center-title">我的春熙路日常</h2></div>${button('close','×','class="player-close" aria-label="关闭个人中心"')}</header><nav class="player-tabs" aria-label="个人信息分类">${Object.entries(TABS).map(([id,label]) => button(`tab-${id}`, label, `aria-pressed="${tab === id}" class="${tab === id ? 'is-active' : ''}"`)).join('')}</nav><div class="player-panel-body">${tab === 'wallet' ? wallet() : tab === 'visits' ? visits() : tab === 'gifts' ? gifts() : traveler()}</div><p class="player-center-notice ${noticeError ? 'is-error' : ''}" role="status" aria-live="polite">${escape(notice)}</p>`;
  }
  function updateProfile(value) { profile = normalizeAvatarProfile(value); drawCard(); drawDialog(); }
  function applyState(value) { state = playerStateView(value); drawCard(); drawDialog(); }
  function updateState(value) { ++refreshSequence; applyState(unwrap(value)); }
  async function refresh() {
    if (!getState) return;
    const sequence = ++refreshSequence;
    try { const result = await getState(); if (destroyed || sequence !== refreshSequence) return; if (result) applyState(unwrap(result)); }
    catch (error) { if (!destroyed && sequence === refreshSequence) { notice = error?.message || '档案暂时无法同步，请稍后重试。'; noticeError = true; drawDialog(); } }
  }
  function open(nextTab = 'traveler') {
    if (destroyed) return;
    if (!Object.hasOwn(TABS, nextTab)) throw new Error('未知个人中心页面。');
    tab = nextTab; confirmation = cancelOrder = null;
    if (!opened) { previousFocus = doc.activeElement; opened = true; drawDialog(); dialog.showModal(); card.setAttribute('aria-expanded','true'); onOpenChange?.(true); }
    else drawDialog();
    dialog.querySelector('[data-player-action="close"]')?.focus(); void refresh();
  }
  function close() {
    if (!opened) return;
    opened = false; confirmation = cancelOrder = null; dialog.close(); card.setAttribute('aria-expanded','false'); onOpenChange?.(false); if (previousFocus?.isConnected) previousFocus.focus();
  }
  async function runAction(action, payload) {
    if (busy || destroyed) return;
    if (!onAction) { notice = '此功能尚未连接，请稍后再试。'; noticeError = true; drawDialog(); return; }
    const transaction = ['redeem','cancel-redemption','receive-demo-redemption'].includes(action);
    if (!transaction) close();
    const sequence = ++actionSequence; busy = transaction; notice = ''; noticeError = false; drawDialog();
    try {
      const result = await onAction(action, payload);
      if (destroyed || sequence !== actionSequence) return;
      if (result?.state || result?.wallet) updateState(result);
      if (transaction) { confirmation = cancelOrder = null; notice = result?.message || (action === 'cancel-redemption' ? '已取消兑换，交子已退回同一钱包。' : action === 'receive-demo-redemption' ? '已完成试玩领取，记录已保存。' : '已提交兑换。最新余额与兑换记录已同步到交子账本。'); await refresh(); }
    } catch (error) {
      if (!destroyed && sequence === actionSequence) { notice = error?.message || '操作未完成，请核对记录后重试。'; noticeError = true; }
    } finally { if (!destroyed && sequence === actionSequence) { busy = false; drawDialog(); } }
  }
  function clicked(event) {
    const target = event.target.closest?.('[data-player-action]'); if (!target || target.disabled) return;
    const action = target.dataset.playerAction;
    if (action === 'close') { close(); return; }
    if (action.startsWith('tab-')) { const next = action.slice(4); if (Object.hasOwn(TABS, next)) { tab = next; confirmation = cancelOrder = null; drawDialog(); } return; }
    if (action === 'select-gift') { const gift = state.gifts.find(item => item.id === target.dataset.playerGift); if (!busy && gift && state.ready && state.balance >= gift.cost) { confirmation = gift; cancelOrder = null; drawDialog(); dialog.querySelector('[data-player-action="confirm-gift"]')?.focus(); } return; }
    if (action === 'cancel-gift') { confirmation = null; drawDialog(); return; }
    if (action === 'confirm-gift') { const gift = confirmation; if (gift && state.ready && state.balance >= gift.cost) void runAction('redeem', { giftId: gift.id }); return; }
    if (action === 'select-cancel-order') { const order = state.redemptions.find(item => item.id === target.dataset.playerOrder && item.status === 'pending'); if (!busy && order) { cancelOrder = order; confirmation = null; drawDialog(); dialog.querySelector('[data-player-action="confirm-cancel-order"]')?.focus(); } return; }
    if (action === 'dismiss-cancel-order') { cancelOrder = null; drawDialog(); return; }
    if (action === 'confirm-cancel-order') { if (cancelOrder && state.redemptions.some(item => item.id === cancelOrder.id && item.status === 'pending')) void runAction('cancel-redemption', { id: cancelOrder.id }); return; }
    if (action === 'receive-order') { const order = state.redemptions.find(item => item.id === target.dataset.playerOrder && item.status === 'pending'); if (order) void runAction('receive-demo-redemption', { id: order.id }); return; }
    if (['open-avatar','focus-avatar','open-planner','open-checkin'].includes(action)) void runAction(action);
    else if (action === 'open-jiaozi') void runAction(action, { view: target.dataset.playerView });
  }
  const onEntry = () => open();
  const onCancel = event => { event.preventDefault(); close(); };
  const onKeys = event => event.stopPropagation();
  card.addEventListener('click', onEntry); dialog.addEventListener('click', clicked); dialog.addEventListener('cancel', onCancel); dialog.addEventListener('keydown', onKeys);
  drawCard(); void refresh();
  return { open, close, isOpen: () => opened, updateProfile, updateState,
    destroy() { if (destroyed) return; close(); destroyed = true; refreshSequence++; actionSequence++; card.removeEventListener('click',onEntry); dialog.removeEventListener('click',clicked); dialog.removeEventListener('cancel',onCancel); dialog.removeEventListener('keydown',onKeys); card.remove(); dialog.remove(); }
  };
}
