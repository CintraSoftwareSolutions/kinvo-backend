import { redis } from '@/db/redis';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { getLimit, isUnlimited } from './entitlements.service';
import { ENTITLEMENT_KEYS, type EntitlementKey, type QuotaState } from './entitlements.types';

/**
 * Daily business quotas (spec §4.9, §5.11, Batch 6).
 *
 * A quota is NOT a rate limit. Rate limits protect infrastructure and answer
 * 429 RATE_LIMITED; quotas exist to sell subscriptions and answer 422
 * QUOTA_EXCEEDED carrying the context the app needs to draw an upgrade sheet.
 * They share no code with `@middleware/rate-limit` on purpose — conflating them
 * hides the paywall and costs revenue.
 *
 * Counters live in Redis so a limit means the same thing across every instance.
 * A per-process counter multiplies the real limit by the instance count.
 */

/** Quota name -> the entitlement flag that supplies its ceiling. */
export const QUOTAS = {
  swipes: ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT,
  messages: ENTITLEMENT_KEYS.DAILY_MESSAGE_LIMIT,
} as const satisfies Record<string, EntitlementKey>;

export type QuotaName = keyof typeof QUOTAS;

export const ALL_QUOTA_NAMES = Object.keys(QUOTAS) as QuotaName[];

/**
 * Check and increment in one atomic step.
 *
 * Doing this as GET-then-INCR in application code lets two concurrent requests
 * both read "49 of 50" and both proceed. A free user with a fast finger would
 * quietly exceed the cap, which is exactly the limit that is supposed to sell a
 * subscription. Lua runs server-side with nothing interleaved.
 *
 * Returns {allowed, value}. The TTL is only set when absent, so re-running
 * never extends a window that is already counting down to UTC midnight.
 */
const CONSUME_SCRIPT = `
local limit = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current + cost > limit then
  return {0, current}
end
local updated = redis.call('INCRBY', KEYS[1], cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return {1, updated}
`;

/** The next UTC midnight — quotas reset on the UTC day, never the user's. */
export function nextResetAt(now: Date = new Date()): Date {
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return reset;
}

function secondsUntilReset(now: Date = new Date()): number {
  // +60s of slack so a counter never expires a moment before the day rolls
  // over and hands out a second allowance inside the same UTC day.
  return Math.ceil((nextResetAt(now).getTime() - now.getTime()) / 1000) + 60;
}

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function quotaKey(userId: string, quota: QuotaName, now: Date = new Date()): string {
  return `quota:${quota}:${userId}:${utcDay(now)}`;
}

async function readCount(userId: string, quota: QuotaName): Promise<number> {
  try {
    const raw = await redis.get(quotaKey(userId, quota));
    return raw === null ? 0 : Number.parseInt(raw, 10) || 0;
  } catch (error) {
    // Reporting 0 used is the honest answer when the counter is unreachable:
    // see the fail-open note on consumeQuota.
    logger.error({ err: error, quota, user_id: userId }, 'quota read failed');
    return 0;
  }
}

/**
 * Current state without consuming anything — for `GET /me/entitlements` and for
 * showing "12 swipes left today" before the user acts.
 */
export async function checkQuota(userId: string, quota: QuotaName): Promise<QuotaState> {
  const limit = await getLimit(userId, QUOTAS[quota]);
  const resets_at = nextResetAt().toISOString();

  if (isUnlimited(limit)) {
    // Unlimited never touches Redis. Paid users are the majority of traffic on
    // these paths and must not pay a network round trip for a counter that
    // could not stop them.
    return { limit: -1, used: 0, remaining: -1, is_unlimited: true, resets_at };
  }

  const used = await readCount(userId, quota);

  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    is_unlimited: false,
    resets_at,
  };
}

/**
 * Consumes allowance, throwing 422 QUOTA_EXCEEDED when the day is spent.
 *
 * ON REDIS FAILURE THIS FAILS OPEN, deliberately. Quotas only bind free users;
 * paid tiers are unlimited and never reach the counter. Failing closed would
 * turn a cache outage into "nobody can swipe or send a message" — a total
 * product outage — to protect revenue from a free tier. Failing open turns the
 * same outage into a generous day. The error is logged at error level so the
 * outage is still visible.
 */
export async function consumeQuota(
  userId: string,
  quota: QuotaName,
  cost = 1,
): Promise<QuotaState> {
  const limit = await getLimit(userId, QUOTAS[quota]);
  const resets_at = nextResetAt().toISOString();

  if (isUnlimited(limit)) {
    return { limit: -1, used: 0, remaining: -1, is_unlimited: true, resets_at };
  }

  const now = new Date();
  let allowed = true;
  let value = 0;

  try {
    const result = (await redis.eval(
      CONSUME_SCRIPT,
      1,
      quotaKey(userId, quota, now),
      String(limit),
      String(cost),
      String(secondsUntilReset(now)),
    )) as [number, number];

    allowed = result[0] === 1;
    value = result[1];
  } catch (error) {
    logger.error(
      { err: error, quota, user_id: userId },
      'quota counter unavailable — failing open',
    );
    return { limit, used: 0, remaining: limit, is_unlimited: false, resets_at };
  }

  if (!allowed) {
    // 422, not 429. The app reads `details` to draw the upgrade sheet, so the
    // paywall context is the payload, not decoration (spec §4.9).
    throw new ApiError(ERROR_CODES.QUOTA_EXCEEDED, quotaMessage(quota, limit), {
      quota,
      limit,
      used: value,
      remaining: 0,
      resets_at,
      upgrade_available: true,
    });
  }

  return {
    limit,
    used: value,
    remaining: Math.max(0, limit - value),
    is_unlimited: false,
    resets_at,
  };
}

/**
 * Gives allowance back — for an action that consumed quota and then failed, so
 * a user is never charged for a swipe the database rejected.
 */
export async function refundQuota(userId: string, quota: QuotaName, cost = 1): Promise<void> {
  try {
    const key = quotaKey(userId, quota);
    const value = await redis.decrby(key, cost);
    if (value < 0) {
      await redis.set(key, '0', 'KEEPTTL');
    }
  } catch (error) {
    logger.error({ err: error, quota, user_id: userId }, 'quota refund failed');
  }
}

/** Every quota in one pass, for the entitlements endpoint. */
export async function checkAllQuotas(userId: string): Promise<Record<QuotaName, QuotaState>> {
  const entries = await Promise.all(
    ALL_QUOTA_NAMES.map(async (name) => [name, await checkQuota(userId, name)] as const),
  );
  return Object.fromEntries(entries) as Record<QuotaName, QuotaState>;
}

function quotaMessage(quota: QuotaName, limit: number): string {
  const nouns: Record<QuotaName, string> = {
    swipes: `${limit} swipes`,
    messages: `${limit} messages`,
  };
  return `You have used all ${nouns[quota]} for today. Upgrade for unlimited.`;
}

/** Test helper: clears a user's counters so cases can run in any order. */
export async function resetQuotas(userId: string): Promise<void> {
  await Promise.all(ALL_QUOTA_NAMES.map((name) => redis.del(quotaKey(userId, name))));
}
