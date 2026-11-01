// The map owns exploration; digital-jiaozi owns the only wallet and ledger.
// These are test experience stations at real places, not contracted merchants.
export const EXPERIENCE_STATIONS = Object.freeze([
  { id: 'chunxi-ifs', name: 'IFS 探索站', placeId: '615aa960444f34a7283a9f19', landmarkId: 'landmark-01', description: '在熊猫地标旁，为城市探索留下第一枚印记。' },
  { id: 'chunxi-taikoo', name: '太古里西入口探索站', placeId: '762ecc492eebc3b816c905f8', landmarkId: 'landmark-02', description: '从现代商场走向低矮街巷，发现另一种成都。' },
  { id: 'chunxi-souvenir', name: '四川特产体验站', placeId: '33c2f348fd9d4b15873304b8', description: '给旅行挑一件纪念，让走过的街角留在日常。' },
  { id: 'chunxi-kaojiang', name: '烤匠 IFS 体验站', placeId: '631c7a2c63b4dba4c42ba1f6', description: '把美食也写进路线，慢下来享受一站。' },
]);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sharedWallet = value => value?.demo === true && value.sample !== true &&
  Number.isSafeInteger(value.wallet?.balance) && value.wallet.balance >= 0 &&
  Number.isSafeInteger(value.wallet?.earned) && value.wallet.earned >= 0 ? value : null;
// The bridge checks the currently selected saved snapshot. A different preview
// cannot silently attach an unrelated active route to a check-in.
const selectedRouteId = state => state?.mode === 'saved' && state?.route?.route_id &&
  state.route.route_id === state.activeRoute?.route_id ? state.route.route_id : null;
export function experienceStations(places) {
  return EXPERIENCE_STATIONS.flatMap(station => {
    const place = (Array.isArray(places) ? places : []).find(p => p?.id === station.placeId);
    return Array.isArray(place?.position) && place.position.length >= 2 && place.position.every(Number.isFinite)
      ? [{ ...station, placeName: place.name, position: [...place.position] }] : [];
  });
}
export function chinaDay(date = new Date()) {
  const timestamp = date instanceof Date ? date.getTime() : NaN;
  const shifted = new Date(timestamp + 8 * 3600000);
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString().slice(0, 10) : null;
}
export function stationVisit(state, merchantId, date = new Date()) {
  const today = chinaDay(date);
  if (!today || !Array.isArray(state?.merchantCheckins)) return null;
  return state.merchantCheckins.find(item => item?.merchantId === merchantId &&
    (item.day === today || !item.day && typeof item.occurredAt === 'string' && chinaDay(new Date(item.occurredAt)) === today)) || null;
}
export function journeyTask(state) {
  const route = state?.route || state?.activeRoute;
  if (!route) return { title: '今天，想怎样认识成都？', subtitle: '说出兴趣、时间和预算，出发去属于你的下一站。', action: 'plan', label: '定制我的路线', complete: false };
  const active = Boolean(state.activeRoute?.route_id && state.activeRoute.route_id === route.route_id && state.mode !== 'preview');
  const completedIds = active ? state.progress?.completed_place_ids || route.progress?.completed_place_ids : [];
  const done = new Set(Array.isArray(completedIds) ? completedIds : []);
  const stops = (Array.isArray(route.stops) ? route.stops : []).filter(stop => stop && typeof stop.place_id === 'string');
  const next = stops.find(p => !done.has(p.place_id)), completed = stops.filter(p => done.has(p.place_id)).length;
  return { title: active ? next ? `下一站 · ${next.name}` : '这段旅程，已走成故事' : '你的个性路线已就绪',
    subtitle: `${active ? '行程' : '路线预览'} ${completed} / ${stops.length} 站${active ? ' · 到访后确认行程进度' : ' · 保存并开始后记录进度'}`,
    action: active ? 'live' : 'plan', label: active ? '查看行程' : '查看与开始', complete: active && stops.length > 0 && !next };
}

export function createGameHub({ host = window, merchants = [], getState, issueDemo, onOpenChange, onPlanner, onPlayer, onFocusMerchant } = {}) {
  const doc = host.document, stage = doc.getElementById('stage') || doc.body;
  const stations = merchants.map(m => ({ ...m }));
  const quest = doc.createElement('section'); quest.className = 'game-quest'; quest.setAttribute('aria-label', '我的街区任务'); stage.append(quest);
  const dialog = doc.createElement('dialog'); dialog.id = 'map-merchant-center'; dialog.className = 'merchant-center'; dialog.setAttribute('aria-label', '街区打卡与商家发放'); doc.body.append(dialog);
  let opened = false, destroyed = false, walletState = null, routeState = null, selectedId = stations[0]?.id, busy = false, confirmation = null, notice = '', failed = false, previousFocus, revision = 0, lifecycle = 0, stateRevision = 0, eventSequence = 0;
  const taskButton = (action, label, extra = '') => `<button type="button" data-game-action="${action}" ${extra}>${label}</button>`;
  function drawQuest() {
    const task = journeyTask(routeState), count = walletState ? stations.filter(m => stationVisit(walletState, m.id)).length : '—';
    quest.innerHTML = `<span class="game-quest-kicker">CHUNXI · 城市冒险</span><strong>${escape(task.title)}</strong><p>${escape(task.subtitle)}</p><div>${taskButton(task.action, task.label)}${taskButton('checkin', `商家打卡 <small>${count}/${stations.length}</small>`)}</div>`;
  }
  function draw() {
    if (!opened || destroyed) return;
    if (confirmation && !busy && stationVisit(walletState, confirmation.merchantId)) confirmation = null;
    const station = stations.find(m => m.id === selectedId), visit = station && stationVisit(walletState, station.id);
    dialog.innerHTML = `<header><div><small>把探索变成相遇</small><h2>街角有交子</h2></div>${taskButton('close', '×', 'aria-label="返回地图"')}</header>
      <p class="merchant-intro">选择路线去探索，在店内完成打卡，由商家发放交子，再换一份旅行的纪念。</p>
      <div class="merchant-mode"><b>当前：本机试玩</b><span>体验站使用真实地点；尚未接入实际合作商家、定位核验和线下核销。试玩交子不用于线下结算。</span></div>
      <div class="merchant-layout"><nav aria-label="体验站">${stations.map(m => `${taskButton('station', `<span>${escape(m.name)}</span><small>${stationVisit(walletState, m.id) ? '今日已领取 ✓' : '每日 +10 交子'}</small>`, `data-merchant="${escape(m.id)}" aria-pressed="${m.id === selectedId}"`)}`).join('') || '<p>当前板块没有可用体验站。</p>'}</nav>
      <section class="merchant-detail">${station ? `<span class="merchant-seal" aria-hidden="true">交</span><h3>${escape(station.name)}</h3><p>${escape(station.description || station.placeName || '')}</p><div class="merchant-reward"><b>+10</b><span>枚交子<br><small>每站每日一次 · 北京时间</small></span></div><p class="merchant-checkin-state">${visit ? '今天的印记已留在钱包和打卡记录中。' : !walletState ? '正在同步试玩钱包，请稍候或刷新记录。' : '试玩可模拟商家发放，体验一次完整的入账流程。'}</p><div class="merchant-actions">${taskButton('focus', '在地图上看看', `data-merchant="${escape(station.id)}"`)}${taskButton('prepare-issue', visit ? '今日已领取' : '模拟商家发放', `data-merchant="${escape(station.id)}" ${busy || visit || !walletState ? 'disabled' : ''}`)}</div>` : ''}</section></div>
      ${confirmation ? `<section class="merchant-confirm" role="group" aria-label="确认试玩打卡"><strong>模拟 ${escape(stations.find(m => m.id === confirmation.merchantId)?.name)} 发放 10 交子？</strong><p>这会保存试玩打卡和钱包流水，不代表真实到店或商家验证。</p><div>${taskButton('cancel-issue', '先等等', busy ? 'disabled' : '')}${taskButton('issue', busy ? '正在入账…' : '确认试玩发放', busy ? 'disabled' : '')}</div></section>` : ''}
      <p class="merchant-notice ${failed ? 'is-error' : ''}" role="status" aria-live="polite">${escape(notice)}</p><footer>${taskButton('refresh', '刷新钱包与打卡', busy ? 'disabled' : '')}${taskButton('wallet', '查看交子钱包 →')}${taskButton('gifts', '挑选旅途礼品 →')}${routeState?.activeRoute ? taskButton('live', '回到行程确认这一站 →') : ''}</footer>`;
  }
  function close() {
    if (!opened) return;
    opened = false; revision++; lifecycle++; confirmation = null; dialog.close(); onOpenChange?.(false);
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  async function refresh() {
    if (destroyed || busy || !getState) return;
    const seq = ++revision;
    try {
      const state = await getState(); if (destroyed || seq !== revision) return;
      if (!sharedWallet(state)) throw new Error('未收到可用的试玩钱包，请刷新核对。');
      walletState = state; stateRevision++; failed = false; notice = ''; drawQuest(); draw();
    } catch (error) { if (!destroyed && seq === revision) { notice = error?.message || '钱包暂时无法同步。'; failed = true; draw(); } }
  }
  function openCheckin(id) {
    if (destroyed) return;
    if (stations.some(m => m.id === id)) selectedId = id;
    lifecycle++; confirmation = null; notice = ''; failed = false;
    if (!opened) { previousFocus = doc.activeElement; opened = true; dialog.showModal(); onOpenChange?.(true); }
    draw(); dialog.querySelector('button')?.focus(); void refresh();
  }
  async function action(event) {
    const target = event.target.closest?.('[data-game-action]'); if (!target || target.disabled || destroyed) return;
    const name = target.dataset.gameAction, merchantId = target.dataset.merchant;
    if (name === 'close') close();
    else if (name === 'checkin') openCheckin();
    else if (name === 'plan' || name === 'live') { close(); onPlanner?.(name === 'live' ? 'live' : 'plan'); }
    else if (name === 'wallet' || name === 'gifts') { close(); onPlayer?.(name); }
    else if (name === 'refresh' && !busy) { confirmation = null; await refresh(); }
    else if (name === 'station' && opened && !busy && stations.some(m => m.id === merchantId)) { selectedId = merchantId; confirmation = null; notice = ''; failed = false; draw(); }
    else if (name === 'focus') { const m = stations.find(m => m.id === merchantId); if (m) { close(); onFocusMerchant?.(m); } }
    else if (name === 'prepare-issue' && opened && !busy && walletState && stations.some(m => m.id === merchantId) && !stationVisit(walletState, merchantId)) {
      const routeId = selectedRouteId(routeState);
      const eventId = host.crypto?.randomUUID?.() || globalThis.crypto?.randomUUID?.() || `map-checkin-${Date.now()}-${++eventSequence}-${Math.random().toString(36).slice(2)}`;
      confirmation = { merchantId, payload: { merchantId, eventId, source: 'demo', ...(routeId ? { routeId } : {}) } };
      notice = ''; failed = false; draw(); dialog.querySelector('[data-game-action="issue"]')?.focus();
    }
    else if (name === 'cancel-issue' && !busy) { confirmation = null; draw(); }
    else if (name === 'issue' && opened && confirmation && !busy) {
      if (stationVisit(walletState, confirmation.merchantId)) { confirmation = null; notice = '今日已经领过，未重复发放。'; draw(); return; }
      const pending = confirmation, session = lifecycle, priorState = stateRevision;
      busy = true; revision++; failed = false; draw();
      try {
        if (!issueDemo) throw new Error('交子发放暂时不可用。');
        const state = await issueDemo({ ...pending.payload });
        if (destroyed) return;
        revision++;
        if (sharedWallet(state) && priorState === stateRevision) { walletState = state; stateRevision++; }
        if (session !== lifecycle) return;
        confirmation = null;
        const receipt = state?.lastCheckin;
        if (!sharedWallet(state) || receipt?.checkin?.merchantId !== pending.merchantId || !Number.isSafeInteger(receipt.awarded) || receipt.awarded < 0 || typeof receipt.duplicate !== 'boolean' || receipt.duplicate && receipt.awarded !== 0) {
          failed = true; notice = '未收到可核对的打卡回执，请刷新钱包与记录核对，勿重复提交。';
        } else notice = receipt.duplicate ? '今日已经领过，未重复发放。' : receipt.awarded > 0 ? `${receipt.awarded} 枚试玩交子已到账，打卡记录已同步到个人中心。` : '打卡已记录，本次未新增试玩交子。';
      } catch (error) { if (!destroyed && session === lifecycle) { failed = true; notice = `${error?.message || '发放结果暂未确认。'} 请先刷新记录核对；重试会沿用本次请求编号。`; } }
      finally { busy = false; if (!destroyed) { revision++; drawQuest(); draw(); } }
    }
  }
  const cancel = event => { event.preventDefault(); close(); };
  const keys = event => event.stopPropagation();
  quest.addEventListener('click', action); dialog.addEventListener('click', action); dialog.addEventListener('cancel', cancel); dialog.addEventListener('keydown', keys);
  drawQuest();
  return { openCheckin, close, isOpen: () => opened,
    setWalletState(state) { if (destroyed || !sharedWallet(state)) return; revision++; stateRevision++; walletState = state; drawQuest(); draw(); },
    setRouteState(state) { if (destroyed) return; if (!busy && selectedRouteId(routeState) !== selectedRouteId(state)) confirmation = null; routeState = state; drawQuest(); draw(); },
    destroy() { if (destroyed) return; close(); destroyed = true; revision++; quest.removeEventListener('click', action); dialog.removeEventListener('click', action); dialog.removeEventListener('cancel', cancel); dialog.removeEventListener('keydown', keys); quest.remove(); dialog.remove(); },
  };
}
