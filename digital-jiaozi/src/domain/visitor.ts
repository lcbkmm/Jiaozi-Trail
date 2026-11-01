import type { State } from './types.ts';
import type { RewardAccount } from '../adapters.ts';
import { ACTIVITY, GIFTS } from '../config/rules.ts';

/** A non-destructive view: old demo transactions remain in the original database. */
export function visitorState(raw: State): State {
  const claims = raw.claims.filter(c => c.source === 'host' || c.source === 'photo');
  const refs = new Set(claims.map(c => c.id));
  const ledger = raw.ledger.filter(l => l.kind === 'earn' && refs.has(l.reference));
  const earned = ledger.reduce((sum, l) => sum + l.amount, 0);
  return { ...raw, claims, ledger, merchantCheckins: [], redemptions: [], wallet: { ...raw.wallet, earned, balance: Math.max(0, Math.min(earned, raw.wallet.balance)) } };
}

/** Reject partial or malformed service responses before showing success. */
export function validateRewardAccount(value: RewardAccount): RewardAccount {
  // Six landmark awards total 60, but verified merchant spending may add more.
  const validPoints = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!value || value.wallet?.activityId !== ACTIVITY.id || !validPoints(value.wallet.earned) || !validPoints(value.wallet.balance) || value.wallet.balance > value.wallet.earned ||
    !Array.isArray(value.availableGiftIds) || value.availableGiftIds.some(id => !GIFTS.some(g => g.id === id)) ||
    !Array.isArray(value.orders) || value.orders.some(o => !o || typeof o.id !== 'string' || !o.id || typeof o.requestId !== 'string' || !o.requestId || o.activityId !== ACTIVITY.id || !GIFTS.some(g => g.id === o.giftId && g.cost === o.cost) || typeof o.title !== 'string' || !['pending', 'received', 'cancelled'].includes(o.status) || !Number.isFinite(Date.parse(o.createdAt)) || (o.receipt !== undefined && typeof o.receipt !== 'string')) ||
    new Set(value.orders.map(o => o.id)).size !== value.orders.length) throw new Error('兑换信息暂时无法确认，请刷新后重试。');
  return structuredClone(value);
}
