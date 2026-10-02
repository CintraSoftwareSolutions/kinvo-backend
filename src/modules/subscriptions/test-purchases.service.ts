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

export type PurchaseMode = 'test' | 'none';

export function purchaseMode(): PurchaseMode {
  return testPurchasesEnabled() ? 'test' : 'none';
}

const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}

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

  await syncTier(userId);

  logger.info({ user_id: userId, product: product.slug }, 'test purchase granted');

  return getMySubscription(userId);
}

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
