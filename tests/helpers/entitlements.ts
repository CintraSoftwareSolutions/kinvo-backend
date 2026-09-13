import { type SubscriptionTier, prisma } from '@/db/prisma';
import { clearEntitlementCache } from '@modules/entitlements/entitlements.service';
import type { EntitlementKey } from '@modules/entitlements/entitlements.types';
import { resetQuotas } from '@modules/entitlements/quota.service';
import { connectRedis, disconnectRedis } from '@/db/redis';
import { seedEntitlements as seedRealMatrix } from '../../prisma/seeds/entitlements';

/**
 * Seeds the REAL matrix, not a hand-built stub.
 *
 * The tier→flag table is data, so a test that invents its own rows proves the
 * resolver works against fixtures nobody ships. Calling production's own seed
 * means a broken matrix fails the suite instead of surfacing in staging.
 */
export async function seedEntitlements(): Promise<void> {
  await seedRealMatrix();
  clearEntitlementCache();
}

/** Overrides one flag for one tier — for testing a limit without seeding 50 swipes. */
export async function setFlag(
  tier: SubscriptionTier,
  key: EntitlementKey,
  value: boolean | number,
): Promise<void> {
  const flag = await prisma.entitlementFlag.findUniqueOrThrow({ where: { key } });
  await prisma.tierEntitlement.update({
    where: { tier_flag_id: { tier, flag_id: flag.id } },
    data: { value },
  });
  clearEntitlementCache();
}

/**
 * Puts a user on a tier by giving them a real SUBSCRIPTION.
 *
 * This used to set `user.subscription_tier` directly. Batch 13 moved
 * entitlement resolution onto Subscription rows — a column somebody can edit is
 * not an entitlement — so writing the column now grants nothing, and a helper
 * that did it would quietly stop working while every test still passed the
 * moment it also asserted "free".
 *
 * Creating the row instead means these tests exercise the same path a real
 * payment takes.
 */
export async function setTier(userId: string, tier: SubscriptionTier): Promise<void> {
  if (tier === 'free') {
    await prisma.subscription.deleteMany({ where: { user_id: userId } });
    await prisma.user.update({ where: { id: userId }, data: { subscription_tier: tier } });
    return;
  }

  const product = await prisma.subscriptionProduct.upsert({
    where: { tier_billing_cycle: { tier, billing_cycle: 'monthly' } },
    create: {
      slug: `test_${tier}_monthly`,
      name: `Test ${tier}`,
      tier,
      billing_cycle: 'monthly',
    },
    update: {},
  });

  const now = new Date();

  await prisma.subscription.create({
    data: {
      user_id: userId,
      product_id: product.id,
      status: 'active',
      source: 'apple',
      original_transaction_id: `test_sub_${userId}_${tier}`,
      current_period_start: now,
      current_period_end: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      auto_renew: true,
    },
  });

  // The denormalised copy, kept in step for admin lists.
  await prisma.user.update({ where: { id: userId }, data: { subscription_tier: tier } });
}

/**
 * Redis survives `resetDatabase()`, so a counter left by one test would still be
 * there for the next and the suite would stop being order-independent (§0.4).
 */
export { resetQuotas };

/**
 * Redis is configured with lazyConnect and NO offline queue under test, so a
 * command issued before an explicit connect fails rather than buffering. Any
 * suite that exercises quota counters must open the connection itself —
 * production does it in server.ts, which tests never load.
 *
 * Skipping this does not fail loudly: `readCount` swallows connection errors
 * and reports zero used, which is indistinguishable from a fresh counter. A
 * suite would pass while proving nothing.
 */
export { connectRedis, disconnectRedis };
