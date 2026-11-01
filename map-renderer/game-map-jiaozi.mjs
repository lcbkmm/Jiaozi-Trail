// Keep the complete digital-jiaozi app in its own viewport and hash router.
// Both sides accept messages only from the same origin and their paired window.
export const JIAOZI_CHANNEL = 'jiaozi-map:v1';
const VIEWS = new Set(['home', 'collection', 'rewards', 'journey', 'photos']);
const LANDMARKS = new Map([
  ['landmark-01', '成都 IFS'], ['landmark-02', '太古里'], ['landmark-03', '九眼桥'],
  ['landmark-04', '大慈寺'], ['landmark-05', '水井坊'], ['landmark-06', '三圣乡'],
]);

export function setupMapJiaozi({ onOpen, onClose, onState, getRouteSnapshot, navigateToPlace, navigateToRoute, navigateToCheckin, merchants = [], host = window } = {}) {
  const doc = host.document;
  const dialog = doc.getElementById('jiaozi-panel');
  const entry = doc.getElementById('open-jiaozi');
  const closeButton = doc.getElementById('close-jiaozi');
  const container = doc.getElementById('jiaozi-frame-container');
  const status = doc.getElementById('jiaozi-load-status');
  const badge = doc.getElementById('jiaozi-points');
  const source = new URL('./assets/digital-jiaozi/index.html#/digital-jiaozi', doc.baseURI);
  if (!dialog || !entry || !closeButton || !container || !status || !badge) throw new Error('数字交子入口缺少必要页面元素');
  if (source.origin !== host.location.origin) throw new Error('数字交子必须从地图同源目录加载');
  let frame, ready = false, opened = false, destroyed = false, queuedView, previousFocus;
  let sequence = 0, bootstrap, loaded = false, playerState;
  let pushVersion = 0, appliedRequest = 0, refreshing = false, refreshRequired = false;
  const pending = new Map(), listeners = new Set();
  if (onState) listeners.add(onState);
  const merchantDirectory = merchants.map(m => ({ id: m.id, name: m.name, ...(m.placeId ? { placeId: m.placeId } : {}), ...(m.landmarkId ? { landmarkId: m.landmarkId } : {}) }));
  const send = message => frame?.contentWindow?.postMessage({ channel: JIAOZI_CHANNEL, ...message }, source.origin);
  const updateWallet = message => {
    const balance = message.wallet?.balance;
    if (!Number.isSafeInteger(balance) || balance < 0) return;
    if (message.sample === true) return; // A separate example archive never replaces the map wallet.
    const label = `${balance} 交子 · 试玩`;
    badge.textContent = label;
    entry.setAttribute('aria-label', `打开我的交子，${label}`);
  };
  const isPlayerState = state => state && state.sample !== true && state.demo === true && Number.isSafeInteger(state.wallet?.balance) && state.wallet.balance >= 0;
  function updateState(state) {
    if (!isPlayerState(state)) return false;
    playerState = state; updateWallet(state);
    for (const listener of listeners) { try { listener(state); } catch (error) { host.console?.error?.('玩家状态更新失败', error); } }
    return true;
  }
  function sendRequest(entry) {
    // Compare with pushes received after actual dispatch, including requests
    // queued during iframe startup. Request numbers order concurrent RPCs.
    entry.pushVersion = pushVersion; entry.sent = true; send(entry.message);
  }
  function reconcileState() {
    // An older command can finish its write after a newer read. A fresh read
    // establishes the current committed state without trusting its old snapshot.
    refreshRequired = true;
    if (refreshing || destroyed) return;
    refreshing = true;
    void (async () => {
      while (refreshRequired && !destroyed) {
        refreshRequired = false;
        await rpc('get-player-state');
      }
    })().catch(showError).finally(() => { refreshing = false; });
  }
  function resolveState(entry, result) {
    if (!isPlayerState(result)) {
      entry.reject(new Error('交子档案返回了无效的试玩钱包状态，请重试。'));
      return;
    }
    const current = entry.pushVersion === pushVersion && entry.order >= appliedRequest;
    if (current) {
      appliedRequest = entry.order; updateState(result);
    }
    // A late snapshot must not roll back either subscribers or the caller's
    // own state update. Keep operation receipts attached to their own command.
    const state = { ...result, ...playerState };
    if (Object.hasOwn(result, 'lastCheckin')) state.lastCheckin = result.lastCheckin;
    else delete state.lastCheckin;
    entry.resolve(state);
    if (!current && entry.message.action !== 'get-player-state') reconcileState();
  }
  function rpc(action, payload) {
    if (destroyed) return Promise.reject(new Error('交子窗口已关闭'));
    ensureFrame();
    const requestId = 'map-' + ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('交子档案暂时没有响应，请重试。')); }, 12000);
      const entry = { resolve, reject, timer, order: sequence, message: { type: 'request', requestId, action, payload }, sent: false };
      pending.set(requestId, entry);
      if (ready) sendRequest(entry);
    });
  }
  function initialize() {
    if (!bootstrap) bootstrap = rpc('initialize', { merchants: merchantDirectory }).catch(error => { bootstrap = undefined; throw error; });
    return bootstrap.then(state => playerState || state);
  }
  async function command(action, payload) {
    await initialize();
    return rpc(action, payload);
  }
  const reply = (requestId, ok, result, error) => {
    if (!destroyed) send({ type: 'response', requestId, ok, result, error });
  };
  async function onMessage(event) {
    if (destroyed || !frame || event.origin !== source.origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || message.channel !== JIAOZI_CHANNEL) return;
    if (message.type === 'ready' || message.type === 'state') {
      if (isPlayerState(message.state)) {
        pushVersion++; updateState(message.state);
      } else if (!playerState) updateWallet(message);
      ready = true; status.hidden = true;
      for (const entry of pending.values()) if (!entry.sent) sendRequest(entry);
      if (queuedView) { send({ type: 'navigate', view: queuedView }); queuedView = undefined; }
    } else if (message.type === 'response' && typeof message.requestId === 'string') {
      const entry = pending.get(message.requestId); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(message.requestId);
      if (message.ok === true) resolveState(entry, message.result);
      else entry.reject(new Error(typeof message.error === 'string' ? message.error : '交子操作失败'));
    } else if (message.type === 'error') {
      status.textContent = '交子档案暂时无法打开，请查看下方提示或重新打开页面。'; status.hidden = false;
    } else if (message.type === 'close') close();
    else if (message.type === 'request' && typeof message.requestId === 'string' && message.requestId.length <= 100) {
      try {
        let result;
        if (message.action === 'get-route') {
          result = await getRouteSnapshot?.() ?? null;
        } else if (message.action === 'navigate-place' || message.action === 'navigate-checkin') {
          const id = message.payload?.id;
          if (!LANDMARKS.has(id)) throw new Error('无法识别这个地标。');
          const merchant = merchantDirectory.find(m => m.landmarkId === id);
          const place = { id, name: LANDMARKS.get(id), placeId: merchant?.placeId || null };
          const available = message.action === 'navigate-checkin' ? await navigateToCheckin?.(place) : await navigateToPlace?.(place);
          if (available !== true) throw new Error('这个地标不在当前春熙路板块范围内，交子仍可收藏。当前地图仅覆盖 IFS 与太古里西入口。');
          result = true;
        } else if (message.action === 'navigate-route') {
          if (!navigateToRoute || await navigateToRoute(message.payload?.routeId) === false) throw new Error('当前春熙路板块没有这条路线，请先选择地图中的缓存探索路线。已保存的旅程仍保留在交子中。');
          result = true;
        } else throw new Error('不支持的地图操作。');
        reply(message.requestId, true, result);
        if (['navigate-place', 'navigate-route', 'navigate-checkin'].includes(message.action)) close();
      } catch (error) { reply(message.requestId, false, undefined, error instanceof Error ? error.message : '地图操作暂时不可用。'); }
    }
  }
  function ensureFrame() {
    if (frame) return;
    frame = doc.createElement('iframe');
    frame.id = 'jiaozi-frame'; frame.title = '数字交子完整功能：收藏、交子钱包、旅程和照片';
    frame.setAttribute('allow', 'clipboard-write');
    frame.addEventListener('load', () => {
      if (destroyed) return;
      if (loaded) {
        ready = false; bootstrap = undefined;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('交子页面正在重新加载，请重试。')); }
        pending.clear(); void initialize().catch(showError);
      }
      loaded = true; send({ type: 'sync' });
    });
    frame.src = source.href; container.append(frame);
  }
  function open(view) {
    if (destroyed) return;
    if (view !== undefined && !VIEWS.has(view)) throw new Error('未知的交子页面');
    if (view !== undefined) queuedView = view;
    ensureFrame();
    if (!opened) {
      previousFocus = doc.activeElement; opened = true;
      dialog.showModal(); entry.setAttribute('aria-expanded', 'true'); onOpen?.();
    }
    if (ready && queuedView) { send({ type: 'navigate', view: queuedView }); queuedView = undefined; }
    send({ type: 'sync' });
    closeButton.focus();
  }
  function close() {
    if (!opened) return;
    opened = false; dialog.close(); entry.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected) previousFocus.focus();
    onClose?.();
  }
  const onEntry = () => open();
  const onCancel = event => { event.preventDefault(); close(); };
  const onBackdrop = event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
  };
  host.addEventListener('message', onMessage);
  entry.addEventListener('click', onEntry); closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', onCancel); dialog.addEventListener('click', onBackdrop);
  function showError(error) { if (!destroyed) { status.textContent = error.message || '交子档案暂时无法读取'; status.hidden = false; } }
  // Load the shared wallet immediately, even while its full collection UI is closed.
  void initialize().catch(showError);
  return {
    open, close, isOpen: () => opened,
    initialize,
    getPlayerState: () => command('get-player-state'),
    demoCheckin: input => command('demo-checkin', input),
    redeem: (giftId, requestId) => command('redeem', { giftId, requestId }),
    cancelRedemption: id => command('cancel-redemption', { id }),
    receiveDemoRedemption: id => command('receive-demo-redemption', { id }),
    onState(listener) { listeners.add(listener); if (playerState) listener(playerState); return () => listeners.delete(listener); },
    destroy() {
      if (destroyed) return;
      close(); destroyed = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('交子窗口已关闭')); }
      pending.clear(); listeners.clear();
      host.removeEventListener('message', onMessage);
      entry.removeEventListener('click', onEntry); closeButton.removeEventListener('click', close);
      dialog.removeEventListener('cancel', onCancel); dialog.removeEventListener('click', onBackdrop);
      frame?.remove();
    },
  };
}
