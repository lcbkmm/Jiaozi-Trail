import { mountDigitalJiaozi } from './module.ts';
import type { ModuleEvent } from './module.ts';
import type { RouteSnapshot } from './domain/types.ts';
import type { View } from './domain/navigation.ts';
import { mapReturnUrl } from './domain/navigation.ts';
import { handleGameRequest } from './game-api.ts';

export function startDigitalJiaozi(mode: 'visitor' | 'demo') {
const channel = 'jiaozi-map:v1';
const views: readonly string[] = ['home', 'collection', 'rewards', 'journey', 'photos'];
// The standalone site stays independent. Only a same-origin parent can bridge it.
let embedded = false;
try { embedded = window.parent !== window && window.parent.location.origin === location.origin; } catch { /* Cross-origin embeds receive no bridge. */ }
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0;
const post = (message: Record<string, unknown>) => window.parent.postMessage({ channel, ...message }, location.origin);
function request(action: string, payload?: unknown) {
  const requestId = 'frame-' + ++sequence;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('地图暂时没有响应，请返回地图后重试。')); }, 12000);
    pending.set(requestId, { resolve, reject, timer });
    post({ type: 'request', requestId, action, payload });
  });
}
const publicBaseUrl = new URL(location.pathname, location.origin).href;
const mapHref = mapReturnUrl(location.href);
const returnToMap = embedded ? () => post({ type: 'close' }) : undefined;
const root = document.getElementById('digital-jiaozi-root')!;
const instance = mountDigitalJiaozi(root, embedded ? {
  mode, publicBaseUrl, openSampleSeparately: true,
  adapters: {
    returnToMap,
    getRouteSnapshot: async () => await request('get-route') as RouteSnapshot | null,
    navigateToRoute: async routeId => { await request('navigate-route', { routeId }); },
    navigateToPlace: async landmark => { await request('navigate-place', { id: landmark.id, name: landmark.name, placeId: landmark.placeId }); },
    ...(mode === 'demo' ? { navigateToCheckin: async (landmark: import('./config/landmarks.ts').Landmark) => { await request('navigate-checkin', { id: landmark.id }); } } : {})
  }
} : { mode, mapHref });
if (embedded) {
  const report = async (type = 'ready', event?: ModuleEvent) => {
    const app = await instance;
    const state = await app.getPlayerState();
    post({ type, wallet: state.wallet, sample: state.sample, state, event });
  };
  window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== window.parent || !event.data || event.data.channel !== channel) return;
    const message = event.data;
    if (message.type === 'response' && typeof message.requestId === 'string') {
      const entry = pending.get(message.requestId); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(message.requestId);
      if (message.ok === true) entry.resolve(message.result);
      else entry.reject(new Error(typeof message.error === 'string' ? message.error : '地图操作暂时不可用。'));
    } else if (message.type === 'request' && typeof message.requestId === 'string' && message.requestId.length <= 100) {
      try {
        const result = await handleGameRequest(await instance, message.action, message.payload, async () => await request('get-route') as RouteSnapshot | null);
        post({ type: 'response', requestId: message.requestId, ok: true, result });
      } catch (error) { post({ type: 'response', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : '交子操作暂时不可用。' }); }
    } else if (message.type === 'sync') {
      try { await report(); } catch { /* Fatal screen is shown by the mount handler below. */ }
    } else if (message.type === 'navigate' && views.includes(message.view)) {
      try { (await instance).navigate(message.view as View); } catch { /* Preserve the fatal screen. */ }
    }
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !root.querySelector('[role="dialog"]')) { event.preventDefault(); post({ type: 'close' }); }
  });
  instance.then(app => {
    app.subscribe(() => { void report('state'); });
    void report();
  }).catch(() => { post({ type: 'error', message: '本地交子档案暂时无法打开，请查看页面提示。' }); });
}
instance.catch(error => {
  const section = document.createElement('section'); section.className = 'dj-app dj-fatal';
  const title = document.createElement('h1'); title.textContent = '暂时无法打开本地交子档案';
  const message = document.createElement('p'); message.textContent = error instanceof Error ? error.message : '本地存储不可用，记录未被覆盖。';
  const retry = document.createElement('button'); retry.className = 'dj-button'; retry.textContent = '重新打开'; retry.onclick = () => location.reload();
  const actions = document.createElement('div'); actions.className = 'dj-fatal-actions';
  if (returnToMap) {
    const back = document.createElement('button'); back.className = 'dj-return-map';
    back.textContent = '← 返回地图'; back.onclick = returnToMap; actions.append(back);
  } else if (mapHref) {
    const back = document.createElement('a'); back.className = 'dj-return-map';
    back.textContent = '← 返回地图'; back.href = mapHref; actions.append(back);
  }
  actions.append(retry); section.append(title, message, actions); root.replaceChildren(section);
});

}
