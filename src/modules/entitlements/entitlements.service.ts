import { type SubscriptionTier, prisma } from '@/db/prisma';
import { isTest } from '@config/env';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import {
  ALL_ENTITLEMENT_KEYS,
  type EntitlementKey,
  type EntitlementMap,
  FLAG_VALUE_TYPES,
  UNLIMITED,
} from './entitlements.types';

/**
 * Entitlement resolution (spec §5.11, Batch 6).
 *
 * The matrix is DATA. Nothing in this file — or anywhere downstream — branches
 * on a tier name. Moving "rewind" from premium to free is a seed edit and a
 * re-seed, never a deploy of new logic. That is the whole point of the design:
 * the open pricing decisions (#2, #3, #7, #10) can be answered after launch
 * without touching code.
 *
 * Batch 13 replaces `user.subscription_tier` with a real subscription lookup.
 * Everything above this file keeps working, because callers ask for a flag and
 * never ask what the user pays.
 */

interface CachedMatrix {
  flags: EntitlementMap;
  expires_at: number;
}

/**
 * The matrix is global, seeded, and changes about once a quarter, so it is
 * cached in process.
 *
 * The user's TIER IS DELIBERATELY NOT CACHED. It changes the instant a payment
 * clears, and a stale tier means someone who just paid is still told to
 * upgrade — the single worst bug this module could have. Same reasoning as
 * `authenticate` reloading the user on every request instead of trusting a
 * token claim.
 */
const matrixCache = new Map<SubscriptionTier, CachedMatrix>();

const CACHE_TTL_MS = 60_000;

/** Tests re-seed between cases, so a cached matrix would leak across them. */
export function clearEntitlementCache(): void {
  matrixCache.clear();
}

function fallbackFor(key: EntitlementKey): boolean | number {
  // Fail closed. A missing row is a broken seed, and handing out a premium
  // feature or an unlimited quota because a row vanished is a revenue leak that
  // nobody would notice. Closed is loud; open is silent.
  return FLAG_VALUE_TYPES[key] === 'boolean' ? false : 0;
}

async function loadMatrix(tier: SubscriptionTier): Promise<EntitlementMap> {
  const cached = matrixCache.get(tier);
  if (cached && cached.expires_at > Date.now()) {
    return cached.flags;
  }

  const rows = await prisma.tierEntitlement.findMany({
    where: { tier },
    select: { value: true, flag: { select: { key: true } } },
  });

  const byKey = new Map(rows.map((row) => [row.flag.key, row.value]));
  const flags = {} as EntitlementMap;

  for (const key of ALL_ENTITLEMENT_KEYS) {
    const raw = byKey.get(key);
    const expected = FLAG_VALUE_TYPES[key];

    if (raw === undefined) {
      logger.error({ tier, flag: key }, 'entitlement flag missing from the matrix');
      flags[key] = fallbackFor(key);
      continue;
    }

    // A stored value of the wrong shape is a broken seed, not a runtime state.
    // Catching it here stops `50` arriving where a boolean was expected and
    // being quietly truthy.
    if (typeof raw !== expected) {
      logger.error(
        { tier, flag: key, expected, actual: typeof raw },
        'entitlement flag has the wrong value type',
      );
      flags[key] = fallbackFor(key);
      continue;
    }

    flags[key] = raw as boolean | number;
  }

  if (!isTest) {
    matrixCache.set(tier, { flags, expires_at: Date.now() + CACHE_TTL_MS });
  }

  return flags;
}

export interface ResolvedEntitlements {
  tier: SubscriptionTier;
  flags: EntitlementMap;
}

/**
 * Every flag for one user, in one call.
 *
 * Callers that need several flags resolve once and read the map rather than
 * asking per flag — the same N+1 rule that applies to compact objects (§4.7).
 */
export async function resolve(userId: string): Promise<ResolvedEntitlements> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    throw ApiError.notFound();
  }

  // Batch 13 moved this off the `subscription_tier` column. That column is
  // still maintained as a denormalised copy for admin lists, but a column
  // somebody can edit is not an entitlement — the tier is now derived from
  // Subscription rows, which are only ever written by a signature-verified
  // provider event.
  //
  // Imported lazily: subscriptions.service imports the notification service,
  // which imports the realtime emitters, and a top-level import here would
  // close that loop.
  const { resolveTier } = await import('@modules/subscriptions/subscriptions.service');
  const tier = await resolveTier(userId);

  return { tier, flags: await loadMatrix(tier) };
}

/** True when the user's tier includes a boolean feature. */
export async function hasFeature(userId: string, key: EntitlementKey): Promise<boolean> {
  const { flags } = await resolve(userId);
  return flags[key] === true;
}

/** A numeric allowance. -1 means unlimited (spec §5.11). */
export async function getLimit(userId: string, key: EntitlementKey): Promise<number> {
  const { flags } = await resolve(userId);
  const value = flags[key];
  return typeof value === 'number' ? value : 0;
}

export function isUnlimited(value: number): boolean {
  return value === UNLIMITED;
}

/**
 * Throws PREMIUM_REQUIRED unless the tier includes the feature.
 *
 * 403 with paywall context, NOT 429 and NOT a bare 403 — the app renders an
 * upgrade sheet from `details`, so stripping the context turns a sales moment
 * into a dead end (spec §4.9).
 */
export async function requireFeature(
  userId: string,
  key: EntitlementKey,
  message?: string,
): Promise<void> {
  const { tier, flags } = await resolve(userId);

  if (flags[key] === true) {
    return;
  }

  throw new ApiError(
    ERROR_CODES.PREMIUM_REQUIRED,
    message ?? 'This feature is available with Premium.',
    { required_feature: key, current_tier: tier, upgrade_available: true },
  );
}
