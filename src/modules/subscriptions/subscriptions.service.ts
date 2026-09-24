import {
  type BillingCycle,
  PaymentSource,
  SubscriptionStatus,
  SubscriptionTier,
  type Prisma,
  prisma,
} from '@/db/prisma';
import { testPurchasesEnabled } from '@config/env';
import { loadMatrix } from '@modules/entitlements/entitlements.service';
import { emitEntitlementsUpdated } from '@/realtime/emit';
import { logger } from '@utils/logger';
import { describePlan } from './plan-features';

/**
 * Subscriptions (spec §5.10).
 *
 * This module READS subscriptions. It cannot create or modify one, and there is
 * deliberately no code path here that grants access — purchasing and receipt
 * validation live outside this codebase entirely, and rows arrive from there.
 *
 * That division is what keeps the spec's rule enforceable:
 *
 *   "Never grant entitlement from a client claim alone. The app sends a
 *    transaction; the server verifies it with the store before anything
 *    changes. A client-trusting implementation is trivially exploitable and
 *    will be exploited."
 *
 * With no writer in this service, the only way a tier can change is a
 * verified subscription row. An endpoint that took a tier, a price or a receipt
 * and acted on it would be the bug.
 *
 * ONE BOUNDED EXCEPTION, in its own file so it can be found and removed:
 * test-purchases.service.ts grants `source = test` rows on request, for
 * staging only, until RevenueCat exists (DECISIONS.md, 24 Sep 2026). Those rows
 * count only while `testPurchasesEnabled()`, which a production boot refuses —
 * checked below, where the tier is decided, not only where rows are written.
 *
 * ENTITLEMENT BELONGS TO THE USER, not a device or a store account. The tier is
 * resolved from Subscription rows keyed on user_id, so signing in anywhere
 * carries it.
 */

/**
 * Statuses that still grant access.
 *
 * `cancelled` is here on purpose: cancelling means "do not renew", and the user
 * has already paid for the rest of the period. `current_period_end` is what
 * actually ends access, checked separately below.
 *
 * `in_grace_period` and `on_billing_retry` are here because the biller is
 * still trying to collect. Cutting someone off over a card that needed
 * reissuing loses the customer AND the payment.
 */
const ENTITLING_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.active,
  SubscriptionStatus.in_grace_period,
  SubscriptionStatus.on_billing_retry,
  SubscriptionStatus.cancelled,
];

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  basic: 1,
  advanced: 2,
};

/**
 * The tier a user is actually entitled to, from subscription rows.
 *
 * This replaces the Batch 6 stub that read `user.subscription_tier` as a hand-
 * set column. That column is still maintained as a denormalised copy for admin
 * lists and analytics, but it is no longer the source of truth — a column
 * somebody can edit is not an entitlement.
 *
 * Takes the HIGHEST entitling tier: someone who upgrades mid-period may briefly
 * hold two rows, and the answer must be the better one rather than whichever
 * the database returned first.
 */
export async function resolveTier(userId: string, now = new Date()): Promise<SubscriptionTier> {
  const subscriptions = await prisma.subscription.findMany({
    where: {
      user_id: userId,
      status: { in: ENTITLING_STATUSES },
      // Access ends when the paid period ends, whatever the status says.
      current_period_end: { gt: now },
      revoked_at: null,
      refunded_at: null,
      // A test plan counts only where test purchases are switched on. Where real
      // users pay, it unlocks nothing — even one that arrived in a database
      // copied from staging.
      ...(testPurchasesEnabled() ? {} : { source: { not: PaymentSource.test } }),
    },
    select: { product: { select: { tier: true } } },
  });

  return subscriptions.reduce<SubscriptionTier>(
    (best, row) => (TIER_RANK[row.product.tier] > TIER_RANK[best] ? row.product.tier : best),
    SubscriptionTier.free,
  );
}

/**
 * Recomputes the tier and writes the denormalised copy.
 *
 * Emits over the socket so a client sitting on the paywall updates the moment
 * its entitlement changes, rather than on next launch.
 */
export async function syncTier(userId: string): Promise<SubscriptionTier> {
  const tier = await resolveTier(userId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscription_tier: true },
  });

  if (user && user.subscription_tier !== tier) {
    await prisma.user.update({ where: { id: userId }, data: { subscription_tier: tier } });

    emitEntitlementsUpdated(userId, tier);

    logger.info({ user_id: userId, tier }, 'subscription tier changed');
  }

  return tier;
}

export interface SubscriptionView {
  id: string;
  tier: SubscriptionTier;
  billing_cycle: BillingCycle;
  product_slug: string;
  status: SubscriptionStatus;
  source: PaymentSource;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  /** True while access is live, whatever the status label says. */
  is_active: boolean;
  cancelled_at: string | null;
  created_at: string;
}

const SUBSCRIPTION_INCLUDE = {
  product: { select: { slug: true, tier: true, billing_cycle: true } },
} satisfies Prisma.SubscriptionInclude;

type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: typeof SUBSCRIPTION_INCLUDE }>;

function toView(subscription: SubscriptionRow, now = new Date()): SubscriptionView {
  return {
    id: subscription.id,
    tier: subscription.product.tier,
    billing_cycle: subscription.product.billing_cycle,
    product_slug: subscription.product.slug,
    status: subscription.status,
    source: subscription.source,
    current_period_start: subscription.current_period_start.toISOString(),
    current_period_end: subscription.current_period_end.toISOString(),
    auto_renew: subscription.auto_renew,
    is_active:
      ENTITLING_STATUSES.includes(subscription.status) &&
      subscription.current_period_end > now &&
      subscription.revoked_at === null &&
      subscription.refunded_at === null &&
      // The same rule `resolveTier` applies, or this would call live a plan
      // that grants nothing.
      (subscription.source !== PaymentSource.test || testPurchasesEnabled()),
    cancelled_at: subscription.cancelled_at?.toISOString() ?? null,
    created_at: subscription.created_at.toISOString(),
  };
}

export interface ProductView {
  slug: string;
  name: string;
  tier: SubscriptionTier;
  billing_cycle: BillingCycle;
  /** spec §4.6: integer minor units plus currency. Never floats. */
  price: { amount_minor: number; currency: string } | null;
  /**
   * What the plan adds over the free tier, in words, from the entitlement
   * matrix — so a feature moved between tiers updates the paywall with no app
   * release. See plan-features.ts.
   */
  features: string[];
}

/**
 * What is on sale.
 *
 * Prices come from the current PriceVersion rather than being hardcoded, so a
 * price change is a row with a new `effective_from` and the old one keeps its
 * history for grandfathering and reporting (spec §5.10).
 *
 * INFORMATIONAL. Whoever takes the payment decides what is actually charged;
 * this is the catalogue the paywall renders, not a price the backend enforces.
 */
export async function listProducts(): Promise<ProductView[]> {
  const now = new Date();

  const products = await prisma.subscriptionProduct.findMany({
    where: { is_active: true },
    orderBy: [{ tier: 'asc' }, { sort_order: 'asc' }],
    include: {
      price_versions: {
        where: {
          effective_from: { lte: now },
          OR: [{ effective_to: null }, { effective_to: { gt: now } }],
        },
        orderBy: { effective_from: 'desc' },
        take: 1,
      },
    },
  });

  // One matrix per tier on sale, and the free tier's to compare against. Each
  // is cached in process for a minute, so the paywall costs nothing extra.
  const tiers = [...new Set(products.map((product) => product.tier))];
  const [free, ...matrices] = await Promise.all([
    loadMatrix(SubscriptionTier.free),
    ...tiers.map((tier) => loadMatrix(tier)),
  ]);
  const featuresByTier = new Map(
    tiers.map((tier, index) => [tier, describePlan(matrices[index]!, free!)]),
  );

  return products.map((product) => {
    const price = product.price_versions[0];

    return {
      slug: product.slug,
      name: product.name,
      tier: product.tier,
      billing_cycle: product.billing_cycle,
      price: price ? { amount_minor: price.amount_minor, currency: price.currency } : null,
      features: featuresByTier.get(product.tier) ?? [],
    };
  });
}

/** The user's own subscription state. */
export async function getMySubscription(userId: string): Promise<{
  tier: SubscriptionTier;
  subscription: SubscriptionView | null;
}> {
  const subscription = await prisma.subscription.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    include: SUBSCRIPTION_INCLUDE,
  });

  return {
    tier: await resolveTier(userId),
    // spec §4.6: null, never an omitted key.
    subscription: subscription ? toView(subscription) : null,
  };
}

/**
 * Expires subscriptions whose paid period has run out.
 *
 * Bookkeeping only: `resolveTier` already checks `current_period_end`, so a
 * lapsed subscription stops entitling the moment it lapses whether or not this
 * has run. It exists so admin lists and analytics can filter on the column.
 */
export async function sweepExpiredSubscriptions(now = new Date()): Promise<number> {
  const lapsed = await prisma.subscription.findMany({
    where: {
      status: { in: [SubscriptionStatus.active, SubscriptionStatus.cancelled] },
      current_period_end: { lte: now },
    },
    select: { id: true, user_id: true },
  });

  if (lapsed.length === 0) {
    return 0;
  }

  await prisma.subscription.updateMany({
    where: { id: { in: lapsed.map((row) => row.id) } },
    data: { status: SubscriptionStatus.expired, expired_at: now },
  });

  for (const userId of new Set(lapsed.map((row) => row.user_id))) {
    await syncTier(userId);
  }

  return lapsed.length;
}

export { ENTITLING_STATUSES };
