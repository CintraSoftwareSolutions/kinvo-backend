import { randomUUID } from 'node:crypto';

import {
  type BillingCycle,
  PaymentSource,
  type Prisma,
  SubscriptionStatus,
  prisma,
} from '@/db/prisma';
import { testPurchasesEnabled } from '@config/env';
import { ApiError } from '@utils/api-error';
import { addMonths } from '@utils/calendar';
import { logger } from '@utils/logger';
import { ENTITLING_STATUSES, getMySubscription, syncTier } from './subscriptions.service';

/**
 * Test purchases (DECISIONS.md, 24 Sep 2026).
 *
 * Tapping Upgrade grants the plan at once, with no payment taken: a stand-in
 * so Basic and Premium can be used end to end before RevenueCat exists. It is
 * the one place in this codebase that turns a request into a subscription —
 * exactly what spec §5.10 forbids for real purchases — so it is fenced three
 * ways:
 *
 *  1. Its routes answer only while `testPurchasesEnabled()`. Anywhere else they
 *     are indistinguishable from routes that do not exist.
 *  2. A production boot with the switch on is refused (config/env.ts).
 *  3. It writes `source = test`, and `resolveTier` honours those rows only while
 *     the switch is on — so even a staging database restored into production
 *     would unlock nothing.
 *
 * When RevenueCat arrives this file is deleted, not adapted. Real purchases
 * reach the server verified by the store, never from a tap.
 */

export type PurchaseMode = 'test' | 'none';

/** How a plan can be bought on this server: by test purchase, or not yet. */
export function purchaseMode(): PurchaseMode {
  return testPurchasesEnabled() ? 'test' : 'none';
}

const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * Serialises test purchases for one user. Two taps racing would otherwise both
 * end the old plan and both start a new one, leaving two live plans — and
 * `resolveTier` takes the higher, so a switch DOWN would silently not happen.
 */
async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}

/**
 * Ends the user's live test plans, at once.
 *
 * Unlike a store cancellation, which keeps access until the period runs out,
 * because the period was paid for: nothing was paid for here, and the point of
 * ending a test plan is to see the tier below it. Store subscriptions are never
 * touched — a tap must not be able to end something somebody paid for.
 */
async function endTestPlans(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<number> {
  const { count } = await tx.subscription.updateMany({
    where: {
      user_id: userId,
      source: PaymentSource.test,
      status: { in: ENTITLING_STATUSES },
    },
    data: { status: SubscriptionStatus.expired, expired_at: now, auto_renew: false },
  });

  return count;
}

/**
 * Grants [productSlug] to the caller, replacing any test plan they hold.
 *
 * Everything but the product is derived: the tier and the period come from the
 * catalogue, and the user is whoever is signed in. There is no way to name
 * anybody else, and no way to name a price.
 */
export async function purchaseForTesting(
  userId: string,
  productSlug: string,
): Promise<Awaited<ReturnType<typeof getMySubscription>>> {
  const product = await prisma.subscriptionProduct.findFirst({
    where: { slug: productSlug, is_active: true },
    select: { id: true, slug: true, billing_cycle: true },
  });

  if (!product) {
    throw ApiError.validation({ product: ['That plan is not on sale.'] });
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);

    // A new plan REPLACES the old one, as switching plans in a store does —
    // the staging grants of 21 Sep included, since those are test plans too.
    // Without this, the highest-tier rule would make switching down impossible.
    await endTestPlans(tx, userId, now);

    await tx.subscription.create({
      data: {
        user_id: userId,
        product_id: product.id,
        status: SubscriptionStatus.active,
        source: PaymentSource.test,
        original_transaction_id: `test-${randomUUID()}`,
        current_period_start: now,
        current_period_end: addMonths(now, CYCLE_MONTHS[product.billing_cycle]),
        // Nothing will ever renew it. A test plan simply ends.
        auto_renew: false,
      },
    });
  });

  // After the commit, never inside it: this announces the change over the
  // socket, and announcing a row a rollback could still remove is the bug the
  // realtime rules exist to prevent.
  await syncTier(userId);

  logger.info({ user_id: userId, product: product.slug }, 'test purchase granted');

  return getMySubscription(userId);
}

/** Ends the caller's test plans, returning them to whatever else they hold. */
export async function cancelTestPlan(
  userId: string,
): Promise<Awaited<ReturnType<typeof getMySubscription>>> {
  const now = new Date();

  const ended = await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    return endTestPlans(tx, userId, now);
  });

  await syncTier(userId);

  logger.info({ user_id: userId, ended }, 'test plan cancelled');

  return getMySubscription(userId);
}
