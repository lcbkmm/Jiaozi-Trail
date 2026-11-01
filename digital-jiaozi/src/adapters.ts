import type { RouteSnapshot, Wallet, Redemption } from './domain/types.ts';
import type { Landmark } from './config/landmarks.ts';
export interface RewardOrder extends Redemption { receipt?: string }
/** Server-authoritative account; no browser-computed balance is submitted. */
export interface RewardAccount {
  wallet: Wallet;
  availableGiftIds: string[];
  orders: RewardOrder[];
}
export interface RewardsAdapter {
  load: () => Promise<RewardAccount>;
  redeem: (input: { activityId: string; giftId: string; requestId: string }) => Promise<RewardAccount>;
  cancel?: (input: { activityId: string; orderId: string; requestId: string }) => Promise<RewardAccount>;
}
export interface HostAdapters {
  returnToMap?: () => void | Promise<void>;
  /** Viewing a map place is navigation, not verified arrival. */
  navigateToPlace?: (landmark: Landmark) => void | Promise<void>;
  rewards?: RewardsAdapter;
  getRouteSnapshot?: () => Promise<RouteSnapshot | null>;
  navigateToCheckin?: (landmark: Landmark) => void | Promise<void>;
  navigateToRoute?: (routeId?: string) => void | Promise<void>;
  // Optional server-side vision bridge. Never accept a frontend API key.
  identifyPhoto?: (photo: Blob) => Promise<{ title?: string }>;
}
