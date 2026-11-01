import { newId } from '../domain/id.ts';
import { ACTIVITY, GIFTS, PERSONAL_DB, SAMPLE_DB } from '../config/rules.ts';
import { LANDMARKS } from '../config/landmarks.ts';
import type { Landmark } from '../config/landmarks.ts';
import { JiaoziError } from '../domain/types.ts';
import type { Claim, Journey, Ledger, Media, Photo, Profile, Redemption, RouteSnapshot, State, VisitInput, Wallet, Merchant, MerchantCheckin, MerchantCheckinInput } from '../domain/types.ts';

const STORES = ['meta', 'wallets', 'journeys', 'claims', 'ledger', 'redemptions', 'media', 'photos', 'events', 'tags', 'archives', 'merchantCheckins'] as const;
type StoreName = typeof STORES[number];
const now = () => new Date().toISOString();
const uid = () => newId();
function requireValue(ok: unknown, message: string, code = 'INVALID_INPUT'): asserts ok {
  if (!ok) throw new JiaoziError(code, message);
}
const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id);
function validateRoute(route: RouteSnapshot | null) {
  if (route) requireValue(validId(route.id) && typeof route.title === 'string' && route.title.length <= 100 && ['demo', 'host'].includes(route.source) && Array.isArray(route.places) && route.places.length <= 100 && route.places.every(p => validId(p.id) && typeof p.name === 'string' && p.name.length <= 100), '路线快照格式不正确');
}
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new JiaoziError('STORAGE_UNAVAILABLE', '当前浏览器无法使用本地数据库，请关闭隐私限制或使用其他浏览器。')); return; }
    const req = indexedDB.open(name, 2);
    req.onupgradeneeded = event => {
      const db = req.result;
      if (event.oldVersion === 0) {
        for (const store of STORES) db.createObjectStore(store, { keyPath: store === 'wallets' ? 'activityId' : 'id' });
        req.transaction!.objectStore('claims').createIndex('activity-landmark', ['activityId', 'landmarkId'], { unique: true });
        req.transaction!.objectStore('redemptions').createIndex('request', 'requestId', { unique: true });
      } else {
        // Add only the new record store; existing wallet, ticket art, media and
        // immutable journeys retain their original IDs and exact amounts.
        if (!STORES.filter(s => s !== 'merchantCheckins').every(s => db.objectStoreNames.contains(s))) { req.transaction!.abort(); return; }
        db.createObjectStore('merchantCheckins', { keyPath: 'id' });
      }
      req.transaction!.objectStore('merchantCheckins').createIndex('activity-merchant-day', ['activityId', 'merchantId', 'day'], { unique: true });
    };
    req.onerror = () => reject(new JiaoziError('STORAGE_VERSION', '本地数据库无法打开或版本不兼容；原记录未删除。请保留此浏览器并联系开发者。'));
    req.onblocked = () => reject(new JiaoziError('STORAGE_BLOCKED', '其他标签页占用了旧数据库，请先关闭其他交子页面再重试。'));
    req.onsuccess = () => {
      const db = req.result;
      if (!STORES.every(s => db.objectStoreNames.contains(s))) {
        db.close(); reject(new JiaoziError('STORAGE_VERSION', '检测到不兼容的旧档案，已保留原数据，不会自动覆盖。')); return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export class JiaoziRepository {
  private db: IDBDatabase;
  private channel?: BroadcastChannel;
  private listeners = new Set<() => void>();
  readonly name: string;
  readonly landmarks: readonly Landmark[];
  private merchants: readonly Merchant[] = [];
  private clock: () => Date = () => new Date();
  private constructor(db: IDBDatabase, name: string, landmarks: readonly Landmark[]) {
    this.db = db; this.name = name; this.landmarks = landmarks;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(name + ':changed');
      this.channel.onmessage = () => this.listeners.forEach(fn => fn());
    }
  }
  static async open(options: { name?: string; landmarks?: readonly Landmark[]; legacy?: Record<string, string>; merchants?: readonly Merchant[]; clock?: () => Date } = {}) {
    const name = options.name || PERSONAL_DB;
    const repo = new JiaoziRepository(await openDatabase(name), name, options.landmarks || LANDMARKS);
    try { repo.configureMerchants(options.merchants || []); if (options.clock) repo.clock = options.clock; await repo.initialize(options.legacy); return repo; } catch (error) { repo.close(); throw error; }
  }
  // All awaits in a transaction are IDB requests; no network, image decoding or timers here.
  private async tx<T>(stores: StoreName[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(stores, mode);
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new JiaoziError('STORAGE_ABORTED', '本地保存失败，未完成任何部分写入，请重试。'));
    });
    try { const result = await run(tx); await completed; return result; }
    catch (error) { try { tx.abort(); } catch { /* already aborted */ } await completed.catch(() => {}); throw error; }
  }
  private changed() { this.channel?.postMessage('changed'); this.listeners.forEach(fn => fn()); }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { this.channel?.close(); this.listeners.clear(); this.db.close(); }
  configureMerchants(merchants: readonly Merchant[]) {
    requireValue(Array.isArray(merchants) && merchants.length <= 200 && merchants.every(m => m && validId(m.id) && typeof m.name === 'string' && m.name.trim().length > 0 && m.name.length <= 100 && (!m.placeId || validId(m.placeId)) && (!m.landmarkId || this.landmarks.some(l => l.id === m.landmarkId))) && new Set(merchants.map(m => m.id)).size === merchants.length, '地图商家配置不正确');
    this.merchants = merchants.map(m => ({ id: m.id, name: m.name.trim(), ...(m.placeId ? { placeId: m.placeId } : {}), ...(m.landmarkId ? { landmarkId: m.landmarkId } : {}) }));
  }
  getMerchants() { return structuredClone(this.merchants); }
  private async initialize(legacy?: Record<string, string>) {
    await this.tx(['meta', 'wallets', 'journeys', 'archives'], 'readwrite', async tx => {
      const meta = tx.objectStore('meta');
      const profile = await request(meta.get('profile'));
      if (profile && profile.schema !== 1) throw new JiaoziError('STORAGE_VERSION', '档案版本不兼容，原数据已保留。');
      if (!profile) await request(meta.add({ id: 'profile', profileId: uid(), schema: 1, createdAt: now() }));
      if (!await request(tx.objectStore('wallets').get(ACTIVITY.id))) await request(tx.objectStore('wallets').add({ activityId: ACTIVITY.id, balance: 0, earned: 0 }));
      if (!await request(meta.get('activeJourney'))) {
        const journey: Journey = { id: uid(), activityId: ACTIVITY.id, title: '我的交子旅程', createdAt: now(), route: null, claimIds: [], photoIds: [] };
        await request(tx.objectStore('journeys').add(journey));
        await request(meta.add({ id: 'activeJourney', value: journey.id }));
      }
      if (legacy && Object.keys(legacy).length && !await request(tx.objectStore('archives').get('legacy-browser'))) {
        await request(tx.objectStore('archives').add({ id: 'legacy-browser', createdAt: now(), reason: '检测到旧版浏览器设置，已另存备份；旧积分不会计入新活动。原键也未修改。', payload: legacy }));
      }
    });
  }
  private currentArt(claim: Claim): Claim {
    const landmark = this.landmarks.find(l => l.id === claim.landmarkId);
    return landmark ? { ...claim, place: { ...structuredClone(landmark), landmarkId: claim.landmarkId } } : claim;
  }
  async state(): Promise<State> {
    return this.tx(['meta', 'wallets', 'claims', 'journeys', 'photos', 'ledger', 'redemptions', 'archives', 'merchantCheckins'], 'readonly', async tx => {
      const raw = await request(tx.objectStore('meta').get('profile'));
      const profile: Profile = { id: raw.profileId, createdAt: raw.createdAt, schema: raw.schema };
      const wallet: Wallet = await request(tx.objectStore('wallets').get(ACTIVITY.id));
      const claims: Claim[] = await request(tx.objectStore('claims').getAll());
      const journeys: Journey[] = await request(tx.objectStore('journeys').getAll());
      const photos: Photo[] = await request(tx.objectStore('photos').getAll());
      const ledger: Ledger[] = await request(tx.objectStore('ledger').getAll());
      const redemptions: Redemption[] = await request(tx.objectStore('redemptions').getAll());
      const merchantCheckins: MerchantCheckin[] = await request(tx.objectStore('merchantCheckins').getAll());
      const archives = (await request(tx.objectStore('archives').getAll())).map(({ id, reason, createdAt }) => ({ id, reason, createdAt }));
      return { profile, wallet, claims: claims.map(c => this.currentArt(c)).sort((a, b) => a.order - b.order), journeys: journeys.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), photos, ledger: ledger.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), redemptions: redemptions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), merchantCheckins: merchantCheckins.sort((a,b) => b.occurredAt.localeCompare(a.occurredAt)), archives };
    });
  }
  async activeJourney(): Promise<Journey> {
    return this.tx(['meta', 'journeys'], 'readonly', async tx => {
      const entry = await request(tx.objectStore('meta').get('activeJourney'));
      const journey = await request(tx.objectStore('journeys').get(entry.value));
      requireValue(journey, '旅程不存在', 'JOURNEY_NOT_FOUND'); return journey;
    });
  }
  async visit(input: VisitInput): Promise<{ claim: Claim; awarded: number; duplicate: boolean }> {
    requireValue(validId(input.eventId) && validId(input.journeyId), '打卡请求编号不正确');
    requireValue(input.activityId === ACTIVITY.id, '当前活动不匹配', 'ACTIVITY_MISMATCH');
    requireValue(input.source === 'demo' || input.source === 'host', '打卡来源不正确');
    requireValue(typeof input.occurredAt === 'string' && Number.isFinite(Date.parse(input.occurredAt)), '打卡时间不正确');
    const landmark = this.landmarks.find(l => input.landmarkId ? l.id === input.landmarkId : input.placeId && l.placeId === input.placeId);
    requireValue(landmark, '该地点尚未映射到本期六款地标', 'UNKNOWN_LANDMARK');
    requireValue(!input.placeId || input.placeId === landmark.placeId, '地标和宿主地点不匹配');
    const fingerprint = JSON.stringify([input.activityId, landmark.id, input.journeyId, input.routeId || null, input.occurredAt, input.source]);
    const result = await this.tx(['events', 'journeys', 'claims', 'wallets', 'ledger'], 'readwrite', async tx => {
      const events = tx.objectStore('events'), claims = tx.objectStore('claims');
      const event = await request(events.get(input.eventId));
      if (event) {
        requireValue(event.fingerprint === fingerprint, '相同事件编号对应了不同内容', 'EVENT_CONFLICT');
        return { claim: await request(claims.get(event.claimId)) as Claim, awarded: 0, duplicate: true };
      }
      const journey: Journey = await request(tx.objectStore('journeys').get(input.journeyId));
      requireValue(journey && journey.activityId === ACTIVITY.id, '当前浏览器暂无这段旅程', 'JOURNEY_NOT_FOUND');
      requireValue(!journey.snapshot, '已保存的纪念页不能继续打卡，请使用当前旅程编号。', 'SNAPSHOT_READONLY');
      requireValue(!input.routeId || journey.route?.id === input.routeId, '打卡路线与当前旅程不匹配', 'ROUTE_MISMATCH');
      const old: Claim | undefined = await request(claims.index('activity-landmark').get([ACTIVITY.id, landmark.id]));
      if (old) {
        await request(events.add({ id: input.eventId, fingerprint, claimId: old.id }));
        return { claim: old, awarded: 0, duplicate: true };
      }
      const wallet: Wallet = await request(tx.objectStore('wallets').get(ACTIVITY.id));
      const count = await request(claims.index('activity-landmark').count(IDBKeyRange.bound([ACTIVITY.id, ''], [ACTIVITY.id, '\uffff'])));
      requireValue(count < ACTIVITY.maxLandmarks, '本期地标已全部领取', 'ACTIVITY_COMPLETE');
      const claim: Claim = {
        id: uid(), activityId: ACTIVITY.id, landmarkId: landmark.id, journeyId: journey.id, eventId: input.eventId,
        source: input.source, occurredAt: input.occurredAt, receivedAt: now(), order: count + 1,
        place: { ...structuredClone(landmark), landmarkId: landmark.id }
      };
      await request(claims.add(claim));
      await request(events.add({ id: input.eventId, fingerprint, claimId: claim.id }));
      journey.claimIds.push(claim.id); await request(tx.objectStore('journeys').put(journey));
      wallet.earned += ACTIVITY.reward; wallet.balance += ACTIVITY.reward; await request(tx.objectStore('wallets').put(wallet));
      await request(tx.objectStore('ledger').add({ id: uid(), activityId: ACTIVITY.id, kind: 'earn', amount: ACTIVITY.reward, title: landmark.name + ' · 首次到访', reference: claim.id, createdAt: now() } satisfies Ledger));
      return { claim, awarded: ACTIVITY.reward, duplicate: false };
    });
    this.changed(); return result;
  }
  async demoCheckin(input: MerchantCheckinInput): Promise<{ checkin: MerchantCheckin; awarded: number; duplicate: boolean }> {
    requireValue(input.source === 'demo', '真实商家核验尚未接入，不能发放正式交子', 'VERIFICATION_UNAVAILABLE');
    requireValue(validId(input.eventId) && validId(input.journeyId) && (!input.routeId || validId(input.routeId)), '打卡请求编号不正确');
    const merchant = this.merchants.find(m => m.id === input.merchantId);
    requireValue(merchant, '该商家不在当前地图的试玩打卡目录中', 'UNKNOWN_MERCHANT');
    const occurredAt = this.clock().toISOString(), day = new Date(Date.parse(occurredAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fingerprint = JSON.stringify(['merchant-demo', ACTIVITY.id, merchant.id, input.journeyId, input.routeId || null]);
    const result = await this.tx(['events', 'journeys', 'merchantCheckins', 'wallets', 'ledger'], 'readwrite', async tx => {
      const events = tx.objectStore('events'), checkins = tx.objectStore('merchantCheckins');
      const event = await request(events.get(input.eventId));
      if (event) {
        requireValue(event.fingerprint === fingerprint, '相同事件编号对应了不同内容', 'EVENT_CONFLICT');
        return { checkin: await request(checkins.get(event.checkinId)) as MerchantCheckin, awarded: 0, duplicate: true };
      }
      const journey: Journey = await request(tx.objectStore('journeys').get(input.journeyId));
      requireValue(journey && journey.activityId === ACTIVITY.id, '当前浏览器暂无这段旅程', 'JOURNEY_NOT_FOUND');
      requireValue(!journey.snapshot, '已保存的纪念页不能继续打卡，请使用当前旅程编号。', 'SNAPSHOT_READONLY');
      requireValue(!input.routeId || journey.route?.id === input.routeId, '打卡路线与当前旅程不匹配', 'ROUTE_MISMATCH');
      const old: MerchantCheckin | undefined = await request(checkins.index('activity-merchant-day').get([ACTIVITY.id, merchant.id, day]));
      if (old) {
        await request(events.add({ id: input.eventId, fingerprint, checkinId: old.id }));
        return { checkin: old, awarded: 0, duplicate: true };
      }
      const wallet: Wallet = await request(tx.objectStore('wallets').get(ACTIVITY.id));
      const checkin: MerchantCheckin = { id: uid(), activityId: ACTIVITY.id, merchantId: merchant.id, placeName: merchant.name, journeyId: journey.id, ...(input.routeId ? { routeId: input.routeId } : {}), eventId: input.eventId, day, occurredAt, source: 'demo', amount: 10 };
      await request(checkins.add(checkin));
      await request(events.add({ id: input.eventId, fingerprint, checkinId: checkin.id }));
      wallet.balance += 10; wallet.earned += 10;
      await request(tx.objectStore('wallets').put(wallet));
      await request(tx.objectStore('ledger').add({ id: uid(), activityId: ACTIVITY.id, kind: 'earn', amount: 10, title: merchant.name + ' · 商家打卡试玩', reference: checkin.id, createdAt: occurredAt } satisfies Ledger));
      return { checkin, awarded: 10, duplicate: false };
    });
    this.changed(); return result;
  }
  async redeem(giftId: string, requestId: string): Promise<Redemption> {
    const gift = GIFTS.find(g => g.id === giftId);
    requireValue(gift && validId(requestId), '礼品或请求编号不正确');
    const result = await this.tx(['wallets', 'redemptions', 'ledger'], 'readwrite', async tx => {
      const store = tx.objectStore('redemptions');
      const old: Redemption | undefined = await request(store.index('request').get(requestId));
      if (old) { requireValue(old.giftId === giftId, '该兑换请求编号已用于另一礼品', 'REQUEST_CONFLICT'); return old; }
      const wallet: Wallet = await request(tx.objectStore('wallets').get(ACTIVITY.id));
      requireValue(wallet.balance >= gift.cost, '可用交子不足，未扣除', 'INSUFFICIENT_POINTS');
      const order: Redemption = { id: uid(), activityId: ACTIVITY.id, requestId, giftId, title: gift.title, cost: gift.cost, status: 'pending', createdAt: now() };
      wallet.balance -= gift.cost; await request(tx.objectStore('wallets').put(wallet));
      await request(store.add(order));
      await request(tx.objectStore('ledger').add({ id: uid(), activityId: ACTIVITY.id, kind: 'spend', amount: -gift.cost, title: gift.title, reference: order.id, createdAt: now() } satisfies Ledger));
      return order;
    });
    this.changed(); return result;
  }
  async updateRedemption(id: string, action: 'cancel' | 'receive'): Promise<Redemption> {
    const result = await this.tx(['redemptions', 'wallets', 'ledger'], 'readwrite', async tx => {
      const store = tx.objectStore('redemptions'), order: Redemption = await request(store.get(id));
      requireValue(order, '没有找到这条兑换记录', 'NOT_FOUND');
      if ((action === 'cancel' && order.status === 'cancelled') || (action === 'receive' && order.status === 'received')) return order;
      requireValue(order.status === 'pending', '此记录已完成处理，不能再次修改', 'ORDER_FINAL');
      order.status = action === 'cancel' ? 'cancelled' : 'received';
      if (action === 'cancel') {
        const wallet: Wallet = await request(tx.objectStore('wallets').get(ACTIVITY.id));
        wallet.balance += order.cost; await request(tx.objectStore('wallets').put(wallet));
        await request(tx.objectStore('ledger').add({ id: uid(), activityId: ACTIVITY.id, kind: 'refund', amount: order.cost, title: order.title + ' · 取消退回', reference: order.id, createdAt: now() } satisfies Ledger));
      }
      await request(store.put(order)); return order;
    });
    this.changed(); return result;
  }
  async addPhoto(input: { journeyId: string; title: string; mode: Photo['mode']; blob: Blob; requestId: string }): Promise<Photo> {
    requireValue(input.blob instanceof Blob && input.blob.type === 'image/png' && input.blob.size > 0 && input.blob.size <= 5 * 1024 * 1024, '照片成品必须为不超过 5 MB 的 PNG');
    requireValue(input.title.trim().length > 0 && input.title.trim().length <= 40 && validId(input.requestId), '请输入 1–40 字照片名称');
    const photo = await this.tx(['journeys', 'media', 'photos'], 'readwrite', async tx => {
      const photos = tx.objectStore('photos'), old = await request(photos.get(input.requestId));
      if (old) return old as Photo;
      const journey: Journey = await request(tx.objectStore('journeys').get(input.journeyId));
      requireValue(journey, '没有找到当前旅程', 'JOURNEY_NOT_FOUND');
      requireValue(!journey.snapshot, '已保存的纪念页不能追加照片，请使用当前旅程编号。', 'SNAPSHOT_READONLY');
      const id = input.requestId, mediaId = uid();
      const photo: Photo = { id, mediaId, journeyId: journey.id, title: input.title.trim(), mode: input.mode, createdAt: now() };
      await request(tx.objectStore('media').add({ id: mediaId, blob: input.blob, createdAt: now() } satisfies Media));
      await request(photos.add(photo)); journey.photoIds.push(id); await request(tx.objectStore('journeys').put(journey)); return photo;
    });
    this.changed(); return photo;
  }
  async media(id: string): Promise<Blob | null> {
    return this.tx(['media'], 'readonly', async tx => (await request(tx.objectStore('media').get(id)))?.blob || null);
  }
  async saveJourney(id: string, title: string, route?: RouteSnapshot | null): Promise<Journey> {
    requireValue(title.trim().length > 0 && title.trim().length <= 60, '旅程名称须为 1–60 字');
    validateRoute(route || null);
    const result = await this.tx(['journeys', 'claims', 'photos'], 'readwrite', async tx => {
      const store = tx.objectStore('journeys'), journey: Journey = await request(store.get(id));
      requireValue(journey, '当前浏览器暂无这段旅程', 'JOURNEY_NOT_FOUND');
      requireValue(!journey.snapshot, '已保存的纪念页不可覆盖，请保存当前进行中的旅程。', 'SNAPSHOT_READONLY');
      journey.title = title.trim(); if (route !== undefined) journey.route = structuredClone(route);
      const claims: Claim[] = await request(tx.objectStore('claims').getAll());
      const photos: Photo[] = await request(tx.objectStore('photos').getAll());
      const previous: Journey[] = await request(store.getAll());
      // Concurrent/rapid saves may share a millisecond; preserve a strict latest-save order.
      const savedAt = new Date(Math.max(Date.now(), ...previous.filter(j => j.savedAt).map(j => Date.parse(j.savedAt!) + 1))).toISOString();
      const saved: Journey = { ...structuredClone(journey), id: uid(), createdAt: savedAt, savedAt,
        snapshot: { title: journey.title, route: structuredClone(journey.route), claims: claims.filter(c => journey.claimIds.includes(c.id)).map(c => this.currentArt(c)).sort((a, b) => a.order - b.order), photos: photos.filter(p => journey.photoIds.includes(p.id)) } };
      await request(store.put(journey)); await request(store.add(saved)); return saved;
    });
    this.changed(); return result;
  }
  async setRouteSnapshot(id: string, route: RouteSnapshot | null) {
    validateRoute(route);
    await this.tx(['journeys'], 'readwrite', async tx => {
      const store = tx.objectStore('journeys'), journey: Journey = await request(store.get(id));
      requireValue(journey && !journey.snapshot, '请为当前进行中的旅程设置路线', 'JOURNEY_NOT_FOUND');
      journey.route = structuredClone(route); await request(store.put(journey));
    });
    this.changed();
  }
  async bindTag(tagId: string, journeyId: string) {
    requireValue(validId(tagId), '标签编号仅支持字母、数字、点、下划线、冒号和短横线');
    await this.tx(['tags', 'journeys'], 'readwrite', async tx => {
      const journey: Journey = await request(tx.objectStore('journeys').get(journeyId));
      requireValue(journey?.snapshot, '请先保存旅程再绑定 NFC 标签');
      const previous = await request(tx.objectStore('tags').get(tagId));
      requireValue(!previous || previous.journeyId === journeyId, '该标签已在本机绑定另一段旅程，请使用其他编号', 'TAG_CONFLICT');
      await request(tx.objectStore('tags').put({ id: tagId, journeyId }));
    });
    this.changed();
  }
  async findJourney(selector: { journeyId?: string; tagId?: string }): Promise<Journey | null> {
    return this.tx(['journeys', 'tags'], 'readonly', async tx => {
      let id = selector.journeyId;
      if (selector.tagId) {
        const tag = await request(tx.objectStore('tags').get(selector.tagId));
        if (!tag || (id && id !== tag.journeyId)) return null;
        id = tag.journeyId;
      }
      if (id) { const found = await request(tx.objectStore('journeys').get(id)); return found?.snapshot ? found : null; }
      const all: Journey[] = await request(tx.objectStore('journeys').getAll());
      return all.filter(j => j.snapshot).sort((a, b) => b.savedAt!.localeCompare(a.savedAt!))[0] || null;
    });
  }
  async legacyArchive() { return this.tx(['archives'], 'readonly', tx => request(tx.objectStore('archives').getAll())); }
}

export function readLegacySettings(storage: Storage): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith('dj:')) result[key] = storage.getItem(key) || ''; }
  return result;
}
export async function resetSample() {
  // Never delete personal data. Callers must close their sample connection first.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SAMPLE_DB);
    req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new JiaoziError('STORAGE_BLOCKED', '请先关闭其他示例标签页，个人档案未改变。'));
  });
}
