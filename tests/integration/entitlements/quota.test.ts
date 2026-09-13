import { redis } from '@/db/redis';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';
import * as quotaService from '@modules/entitlements/quota.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { createAuthenticatedUser } from '../../helpers/auth';
import {
  connectRedis,
  disconnectRedis,
  seedEntitlements,
  setFlag,
  setTier,
} from '../../helpers/entitlements';

/**
 * Daily quota counters (spec 4.9, 5.11, Batch 6).
 *
 * The distinction this suite exists to protect: a quota is a BUSINESS limit
 * that sells subscriptions and answers 422 with paywall context. It is not a
 * rate limit, which protects infrastructure and answers 429. Conflating them
 * hides the paywall.
 */

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('consumeQuota', () => {
  it('counts down from the seeded limit', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 3);
    await quotaService.resetQuotas(user_id);

    expect((await quotaService.consumeQuota(user_id, 'swipes')).remaining).toBe(2);
    expect((await quotaService.consumeQuota(user_id, 'swipes')).remaining).toBe(1);
    expect((await quotaService.consumeQuota(user_id, 'swipes')).remaining).toBe(0);
  });

  it('throws 422 QUOTA_EXCEEDED — never 429 — once the day is spent', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 1);
    await quotaService.resetQuotas(user_id);

    await quotaService.consumeQuota(user_id, 'swipes');

    await expect(quotaService.consumeQuota(user_id, 'swipes')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      statusCode: 422,
    });
  });

  it('carries the paywall context the app renders an upgrade sheet from', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 1);
    await quotaService.resetQuotas(user_id);

    await quotaService.consumeQuota(user_id, 'swipes');

    await expect(quotaService.consumeQuota(user_id, 'swipes')).rejects.toMatchObject({
      details: {
        quota: 'swipes',
        limit: 1,
        remaining: 0,
        upgrade_available: true,
      },
    });
  });

  it('never touches Redis for an unlimited tier', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setTier(user_id, 'advanced');

    const spy = jest.spyOn(redis, 'eval');

    const state = await quotaService.consumeQuota(user_id, 'swipes');

    expect(state.is_unlimited).toBe(true);
    expect(state.remaining).toBe(-1);
    // Paid users are most of the traffic on these paths; a round trip to a
    // counter that could not stop them is pure latency.
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps separate counters per quota', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 2);
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_MESSAGE_LIMIT, 2);
    await quotaService.resetQuotas(user_id);

    await quotaService.consumeQuota(user_id, 'swipes');

    expect((await quotaService.checkQuota(user_id, 'swipes')).used).toBe(1);
    expect((await quotaService.checkQuota(user_id, 'messages')).used).toBe(0);
  });

  it('keeps separate counters per user', async () => {
    const a = await createAuthenticatedUser();
    const b = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 2);
    await quotaService.resetQuotas(a.user_id);
    await quotaService.resetQuotas(b.user_id);

    await quotaService.consumeQuota(a.user_id, 'swipes');

    expect((await quotaService.checkQuota(a.user_id, 'swipes')).used).toBe(1);
    expect((await quotaService.checkQuota(b.user_id, 'swipes')).used).toBe(0);
  });

  it('does not let concurrent requests burst past the cap', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 5);
    await quotaService.resetQuotas(user_id);

    // A GET-then-INCR implementation lets several of these read the same value
    // and all proceed, quietly exceeding the limit that is meant to sell a
    // subscription. The Lua script is what makes this pass.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => quotaService.consumeQuota(user_id, 'swipes')),
    );

    const allowed = results.filter((r) => r.status === 'fulfilled').length;

    expect(allowed).toBe(5);
    expect((await quotaService.checkQuota(user_id, 'swipes')).used).toBe(5);
  });

  it('refuses a cost larger than what is left rather than going negative', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 5);
    await quotaService.resetQuotas(user_id);

    await quotaService.consumeQuota(user_id, 'swipes', 4);

    await expect(quotaService.consumeQuota(user_id, 'swipes', 2)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    // The rejected attempt must not have been counted.
    expect((await quotaService.checkQuota(user_id, 'swipes')).used).toBe(4);
  });
});

describe('checkQuota', () => {
  it('reports state without consuming any allowance', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 10);
    await quotaService.resetQuotas(user_id);

    await quotaService.checkQuota(user_id, 'swipes');
    await quotaService.checkQuota(user_id, 'swipes');

    expect((await quotaService.checkQuota(user_id, 'swipes')).used).toBe(0);
  });
});

describe('refundQuota', () => {
  it('gives allowance back when the action it paid for failed', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 5);
    await quotaService.resetQuotas(user_id);

    await quotaService.consumeQuota(user_id, 'swipes');
    await quotaService.refundQuota(user_id, 'swipes');

    expect((await quotaService.checkQuota(user_id, 'swipes')).used).toBe(0);
  });

  it('floors at zero so a stray refund cannot mint allowance', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 5);
    await quotaService.resetQuotas(user_id);

    await quotaService.refundQuota(user_id, 'swipes');
    await quotaService.refundQuota(user_id, 'swipes');

    const state = await quotaService.checkQuota(user_id, 'swipes');
    expect(state.used).toBe(0);
    expect(state.remaining).toBe(5);
  });
});

describe('the reset boundary', () => {
  it('resets at UTC midnight, not the local midnight of whoever deployed', () => {
    const reset = quotaService.nextResetAt(new Date('2026-08-26T13:45:12.000Z'));

    expect(reset.toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });

  it('rolls to the next day from one second before midnight', () => {
    const reset = quotaService.nextResetAt(new Date('2026-08-26T23:59:59.000Z'));

    expect(reset.toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });

  it('keys the counter by UTC day, so yesterday cannot spend today', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 2);
    await quotaService.resetQuotas(user_id);

    // Yesterday's allowance, fully spent. Each day is its own key, so it
    // expires on its own rather than needing a sweeper job — and it must have
    // no bearing on today.
    //
    // Deliberately NOT tested with jest fake timers: ioredis drives its command
    // queue on real timers, so awaiting a Redis call under faked ones
    // deadlocks. Writing the key directly tests the same property honestly.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const staleKey = `quota:swipes:${user_id}:${yesterday}`;
    await redis.set(staleKey, '2', 'EX', 3600);

    const state = await quotaService.checkQuota(user_id, 'swipes');
    expect(state.used).toBe(0);
    expect(state.remaining).toBe(2);

    await expect(quotaService.consumeQuota(user_id, 'swipes')).resolves.toMatchObject({ used: 1 });

    await redis.del(staleKey);
  });

  it('sets a TTL so counters expire instead of accumulating forever', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 5);
    await quotaService.resetQuotas(user_id);

    await quotaService.consumeQuota(user_id, 'swipes');

    const day = new Date().toISOString().slice(0, 10);
    const ttl = await redis.ttl(`quota:swipes:${user_id}:${day}`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 + 60);
  });
});

describe('a Redis outage', () => {
  it('fails OPEN rather than taking the product down', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 5);

    jest.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('connection refused'));

    // Quotas only bind the free tier. Failing closed would turn a cache outage
    // into "nobody can swipe" — a total outage to protect revenue from users
    // who are not paying. A generous day is the cheaper failure.
    const state = await quotaService.consumeQuota(user_id, 'swipes');

    expect(state.remaining).toBe(5);
    expect(state.is_unlimited).toBe(false);
  });
});
