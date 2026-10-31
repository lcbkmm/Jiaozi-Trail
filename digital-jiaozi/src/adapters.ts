import type { RouteSnapshot } from './domain/types.ts';
import type { Landmark } from './config/landmarks.ts';
export interface HostAdapters {
  getRouteSnapshot?: () => Promise<RouteSnapshot | null>;
  navigateToCheckin?: (landmark: Landmark) => void | Promise<void>;
  navigateToRoute?: (routeId?: string) => void | Promise<void>;
  // Optional server-side vision bridge. Never accept a frontend API key.
  identifyPhoto?: (photo: Blob) => Promise<{ title?: string }>;
}
