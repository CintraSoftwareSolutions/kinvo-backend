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

interface CachedMatrix {
  flags: EntitlementMap;
  expires_at: number;
}

const matrixCache = new Map<SubscriptionTier, CachedMatrix>();

const CACHE_TTL_MS = 60_000;

export function clearEntitlementCache(): void {
  matrixCache.clear();
}

function fallbackFor(key: EntitlementKey): boolean | number {
  // Fail closed. A missing row is a broken seed, and handing out a premium
  // feature or an unlimited quota because a row vanished is a revenue leak that
  // nobody would notice. Closed is loud; open is silent.
  return FLAG_VALUE_TYPES[key] === 'boolean' ? false : 0;
}

export async function loadMatrix(tier: SubscriptionTier): Promise<EntitlementMap> {
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

export async function resolve(userId: string): Promise<ResolvedEntitlements> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    throw ApiError.notFound();
  }
  const { resolveTier } = await import('@modules/subscriptions/subscriptions.service');
  const tier = await resolveTier(userId);

  return { tier, flags: await loadMatrix(tier) };
}

export async function hasFeature(userId: string, key: EntitlementKey): Promise<boolean> {
  const { flags } = await resolve(userId);
  return flags[key] === true;
}

export async function getLimit(userId: string, key: EntitlementKey): Promise<number> {
  const { flags } = await resolve(userId);
  const value = flags[key];
  return typeof value === 'number' ? value : 0;
}

export function isUnlimited(value: number): boolean {
  return value === UNLIMITED;
}

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
