import './ui/styles.css';
import { LANDMARKS } from './config/landmarks.ts';
import type { Landmark } from './config/landmarks.ts';
import { PERSONAL_DB, SAMPLE_DB } from './config/rules.ts';
import { JiaoziRepository, readLegacySettings } from './storage/repository.ts';
import { parseRoute } from './domain/navigation.ts';
import type { VisitInput, Wallet } from './domain/types.ts';
import type { HostAdapters } from './adapters.ts';
import { JiaoziApp } from './ui/app.ts';

export interface MountOptions {
  assetBase?: string;
  publicBaseUrl?: string;
  /** Same-origin feature API by default. Set only to the host's trusted proxy endpoint. */
  magnetApiBase?: string;
  routePrefix?: string;
  routing?: 'hash' | 'memory';
  adapters?: HostAdapters;
  landmarks?: readonly Landmark[];
  allowDemo?: boolean;
  sample?: boolean;
}
export interface ModuleEvent {
  type: 'digital-jiaozi:claim' | 'digital-jiaozi:points';
  wallet: Wallet;
  landmarkId?: string;
  source?: 'host' | 'demo';
}
export async function mountDigitalJiaozi(element: HTMLElement, options: MountOptions = {}) {
  const prefix = options.routePrefix || '/digital-jiaozi';
  const sample = options.sample ?? (options.routing !== 'memory' && parseRoute(location.hash, prefix).sample);
  const landmarks = options.landmarks || LANDMARKS;
  if (landmarks.length !== 6 || LANDMARKS.some(l => !landmarks.find(item => item.id === l.id)) || new Set(landmarks.filter(l => l.placeId).map(l => l.placeId)).size !== landmarks.filter(l => l.placeId).length) throw new Error('地标配置须保持六个稳定内部编号和不重复的 placeId');
  let legacy: Record<string, string> = {};
  try { if (!sample) legacy = readLegacySettings(localStorage); } catch { /* IDB may still be available; no settings needed. */ }
  const repository = await JiaoziRepository.open({ name: sample ? SAMPLE_DB : PERSONAL_DB, landmarks, legacy });
  const listeners = new Set<(event: ModuleEvent) => void>();
  const emit = (event: ModuleEvent) => listeners.forEach(fn => { try { fn(event); } catch (error) { console.error('digital-jiaozi subscriber failed', error); } });
  const app = new JiaoziApp(element, repository, { ...options, routePrefix: prefix, landmarks, sample }, emit);
  await app.start();
  return {
    async acceptCheckin(input: Omit<VisitInput, 'source'>) {
      const result = await repository.visit({ ...input, source: 'host' });
      if (!result.duplicate) {
        const { wallet } = await repository.state();
        emit({ type: 'digital-jiaozi:claim', wallet, landmarkId: result.claim.landmarkId, source: 'host' });
        emit({ type: 'digital-jiaozi:points', wallet, source: 'host' });
      }
      return result;
    },
    getState: () => repository.state(),
    getContext: () => repository.activeJourney(),
    saveJourney: repository.saveJourney.bind(repository),
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
