export type Source = 'demo' | 'host';
export interface Profile { id: string; createdAt: string; schema: 1 }
export interface Wallet { activityId: string; earned: number; balance: number }
export interface PlaceSnapshot { landmarkId: string; placeId: string | null; name: string; color: string; image: string; placeholder: boolean; map: { fit: 'contain' | 'cover'; position: string } }
export interface RouteSnapshot { id: string; title: string; source: Source; places: { id: string; name: string }[]; description?: string }
export interface Journey {
  id: string; activityId: string; title: string; createdAt: string; savedAt?: string;
  route: RouteSnapshot | null; claimIds: string[]; photoIds: string[];
  snapshot?: { claims: Claim[]; photos: Photo[]; route: RouteSnapshot | null; title: string };
}
export interface Claim {
  id: string; activityId: string; landmarkId: string; journeyId: string; eventId: string;
  source: Source; occurredAt: string; receivedAt: string; order: number; place: PlaceSnapshot;
}
export interface Ledger { id: string; activityId: string; kind: 'earn' | 'spend' | 'refund'; amount: number; title: string; createdAt: string; reference: string }
export interface Redemption { id: string; activityId: string; requestId: string; giftId: string; title: string; cost: number; status: 'pending' | 'received' | 'cancelled'; createdAt: string }
export interface Media { id: string; blob: Blob; createdAt: string }
export interface Photo { id: string; journeyId: string; mediaId: string; title: string; createdAt: string; mode: 'color' | 'tone' | 'outline' }
export interface VisitInput {
  eventId: string; activityId: string; landmarkId?: string; placeId?: string;
  journeyId: string; routeId?: string; occurredAt: string; source: Source;
}
export interface State { profile: Profile; wallet: Wallet; claims: Claim[]; journeys: Journey[]; photos: Photo[]; ledger: Ledger[]; redemptions: Redemption[]; archives: { id: string; reason: string; createdAt: string }[] }
export class JiaoziError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'JiaoziError'; }
}
