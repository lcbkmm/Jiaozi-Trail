import './ui/styles.css';
import { LANDMARKS } from './config/landmarks.ts';
import type { Landmark } from './config/landmarks.ts';
import { PERSONAL_DB, SAMPLE_DB, GIFTS } from './config/rules.ts';
import { JiaoziRepository, readLegacySettings } from './storage/repository.ts';
import { JiaoziError } from './domain/types.ts';
import type { VisitInput, Wallet, Merchant, MerchantCheckinInput, Source } from './domain/types.ts';
import type { HostAdapters } from './adapters.ts';
import { visitorState } from './domain/visitor.ts';
import { JiaoziApp } from './ui/app.ts';
import './ui/visitor.css';

export interface MountOptions {
  assetBase?: string;
  publicBaseUrl?: string;
  /** Same-origin feature API by default. Set only to the host's trusted proxy endpoint. */
  magnetApiBase?: string;
  routePrefix?: string;
  routing?: 'hash' | 'memory';
  adapters?: HostAdapters;
  landmarks?: readonly Landmark[];
  /** Explicit code-level opt-in. URL parameters never enable simulation. */
  mode?: 'visitor' | 'demo';
  /** @deprecated Use mode: 'demo'. Explicit true still enables isolated demo storage. */
  allowDemo?: boolean;
  sample?: boolean;
  merchants?: readonly Merchant[];
  mapHref?: string;
  /** Legacy option retained; examples now always use a separate entry and database. */
  openSampleSeparately?: boolean;
}
export interface ModuleEvent {
  type: 'digital-jiaozi:claim' | 'digital-jiaozi:points';
  wallet: Wallet;
  landmarkId?: string;
  source?: Source;
}
export async function mountDigitalJiaozi(element: HTMLElement, options: MountOptions = {}) {
  const prefix = options.routePrefix || '/digital-jiaozi';
  const mode = options.mode ?? (options.allowDemo === true ? 'demo' : 'visitor');
  const sample = mode === 'demo';
  const landmarks = options.landmarks || LANDMARKS;
  if (landmarks.length !== 6 || LANDMARKS.some(l => !landmarks.find(item => item.id === l.id)) || new Set(landmarks.filter(l => l.placeId).map(l => l.placeId)).size !== landmarks.filter(l => l.placeId).length) throw new Error('地标配置须保持六个稳定内部编号和不重复的 placeId');
  let legacy: Record<string, string> = {};
  try { if (!sample) legacy = readLegacySettings(localStorage); } catch { /* IDB may still be available; no settings needed. */ }
  const repository = await JiaoziRepository.open({ name: sample ? SAMPLE_DB : PERSONAL_DB, landmarks, legacy, merchants: options.merchants });
  const requireDemo = () => {
    if (mode !== 'demo') throw new JiaoziError('DEMO_DISABLED', '游客入口不支持试玩发放或模拟兑换，请使用独立开发演示入口。');
  };
  const listeners = new Set<(event: ModuleEvent) => void>();
  const emit = (event: ModuleEvent) => listeners.forEach(fn => { try { fn(event); } catch (error) { console.error('digital-jiaozi subscriber failed', error); } });
  const app = new JiaoziApp(element, repository, { ...options, mode, routePrefix: prefix, landmarks, sample }, emit);
  await app.start();
  return {
    async acceptCheckin(input: Omit<VisitInput, 'source'>) {
      const result = await repository.visit({ ...input, source: 'host' });
      if (!result.duplicate) {
        const state = await repository.state();
        const { wallet } = mode === 'visitor' ? visitorState(state) : state;
        emit({ type: 'digital-jiaozi:claim', wallet, landmarkId: result.claim.landmarkId, source: 'host' });
        emit({ type: 'digital-jiaozi:points', wallet, source: 'host' });
      }
      return result;
    },
    getState: () => repository.state(),
    /** Local visitor projection, excluding legacy demo awards. Not the remote reward account. */
    getVisitorState: async () => visitorState(await repository.state()),
    getPlayerState: async () => ({ ...(mode === 'demo' ? await repository.state() : visitorState(await repository.state())), gifts: GIFTS, sample, demo: mode === 'demo', merchants: repository.getMerchants(), activeJourney: await repository.activeJourney() }),
    configureMerchants: repository.configureMerchants.bind(repository),
    async demoCheckin(input: MerchantCheckinInput) { requireDemo(); return repository.demoCheckin(input); },
    async redeem(giftId: string, requestId: string) { requireDemo(); return repository.redeem(giftId, requestId); },
    async cancelRedemption(id: string) { requireDemo(); return repository.updateRedemption(id, 'cancel'); },
    async receiveDemoRedemption(id: string) { requireDemo(); return repository.updateRedemption(id, 'receive'); },
    subscribe: repository.subscribe.bind(repository),
    getContext: () => repository.activeJourney(),
    saveJourney: (id: string, title: string, route?: import('./domain/types.ts').RouteSnapshot | null) => repository.saveJourney(id, title, route, mode === 'demo'),
    setRouteSnapshot: repository.setRouteSnapshot.bind(repository),
    bindTag: repository.bindTag.bind(repository),
    getJourneyUrl: app.getJourneyUrl.bind(app),
    navigate: app.navigate.bind(app),
    openJourney: app.openJourney.bind(app),
    openMagnet: app.openMagnet.bind(app),
    on(listener: (event: ModuleEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { listeners.clear(); app.destroy(); repository.close(); }
  };
}
export type { Landmark, VisitInput, HostAdapters };
export type { RouteSnapshot, Journey, State } from './domain/types.ts';
export type { Merchant, MerchantCheckin, MerchantCheckinInput } from './domain/types.ts';
export type { RewardAccount, RewardOrder, RewardsAdapter } from './adapters.ts';
