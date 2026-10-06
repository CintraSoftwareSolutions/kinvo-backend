import {
  type BillingCycle,
  type PlanRolloutState,
  type SubscriptionStatus,
  type SubscriptionTier,
  prisma,
} from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { ENTITLING_STATUSES } from '@modules/subscriptions/subscriptions.service';
import { writeAudit } from './admin.service';

/**
 * Plan and pricing management for the admin panel (Batch 15).
 *
 * THE RULE THIS FILE EXISTS UNDER (CLAUDE.md, spec §5.10): payment processing
 * is not in this codebase, and **no HTTP route may grant entitlement**.
 *
 * Nothing here touches a `Subscription` row. It edits the CATALOGUE — the
 * products and prices the paywall renders — and that is all. An operator can
 * change what the paywall advertises; they cannot change what anybody is
 * charged, and they cannot give anybody access. Whoever takes the payment
 * decides the first, and `resolveTier` over Subscription rows decides the
 * second.
 *
 * A test asserts both: that these endpoints leave entitlement untouched, and
 * that a price edit creates a version rather than overwriting one.
 *
 * WHY A PRICE IS NEVER UPDATED IN PLACE. Someone subscribed last year at last
 * year's price. Overwriting the row would destroy the record of what they were
 * actually charged, which is needed to grandfather them and to reconcile a
 * dispute. So a price change closes the open version and opens a new one, in
 * one transaction.
 */

export interface AdminProductRow {
  id: string;
  slug: string;
  name: string;
  tier: SubscriptionTier;
  billing_cycle: BillingCycle;
  rollout_state: PlanRolloutState;
  rollout_note: string | null;
  is_active: boolean;
  sort_order: number;
  /** The open price version. `null` when a draft has never been priced. */
  price: { amount_minor: number; currency: string; effective_from: string } | null;
  /** Subscriptions on this product that currently entitle. Counted, not stored. */
  active_subscribers: number;
  /**
   * Monthly recurring revenue contributed by this product, in minor units.
   *
   * APPROXIMATE, and the reason is worth knowing: a yearly price is divided by
   * twelve to make the two cycles comparable on one chart. It is not what was
   * billed this month. The panel labels it MRR; this comment is the caveat.
   */
  mrr_minor: number;
  currency: string | null;
  created_at: string;
}

/** Yearly amounts are normalised to a month so the two cycles can be summed. */
function monthlyEquivalent(amountMinor: number, cycle: BillingCycle): number {
  return cycle === 'yearly' ? Math.round(amountMinor / 12) : amountMinor;
}

const PRODUCT_SELECT = {
  id: true,
  slug: true,
  name: true,
  tier: true,
  billing_cycle: true,
  rollout_state: true,
  rollout_note: true,
  is_active: true,
  sort_order: true,
  created_at: true,
  price_versions: {
    where: { effective_to: null },
    orderBy: { effective_from: 'desc' },
    take: 1,
    select: { amount_minor: true, currency: true, effective_from: true },
  },
} as const;

/**
 * Subscriber counts for every product in one query.
 *
 * `groupBy` rather than a count per product: eight products is eight queries
 * today and more later, and this is the same N+1 rule the compact objects
 * exist to enforce.
 */
async function activeSubscribersByProduct(now: Date): Promise<Map<string, number>> {
  const rows = await prisma.subscription.groupBy({
    by: ['product_id'],
    where: {
      status: { in: [...ENTITLING_STATUSES] as SubscriptionStatus[] },
      refunded_at: null,
      revoked_at: null,
      current_period_end: { gt: now },
    },
    _count: { id: true },
  });

  return new Map(rows.map((row) => [row.product_id, row._count.id]));
}

export async function listSubscriptionProducts(): Promise<AdminProductRow[]> {
  const now = new Date();

  const [products, subscribers] = await Promise.all([
    prisma.subscriptionProduct.findMany({
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      select: PRODUCT_SELECT,
    }),
    activeSubscribersByProduct(now),
  ]);

  return products.map((product) => {
    const price = product.price_versions[0] ?? null;
    const count = subscribers.get(product.id) ?? 0;

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      tier: product.tier,
      billing_cycle: product.billing_cycle,
      rollout_state: product.rollout_state,
      rollout_note: product.rollout_note,
      is_active: product.is_active,
      sort_order: product.sort_order,
      price: price
        ? {
            amount_minor: price.amount_minor,
            currency: price.currency,
            effective_from: price.effective_from.toISOString(),
          }
        : null,
      active_subscribers: count,
      mrr_minor: price
        ? monthlyEquivalent(price.amount_minor, product.billing_cycle) * count
        : 0,
      currency: price?.currency ?? null,
      created_at: product.created_at.toISOString(),
    };
  });
}

/**
 * Editorial changes to a product.
 *
 * `tier` and `billing_cycle` are deliberately NOT editable. They are what the
 * store products are keyed on and what entitlement resolves from — flipping a
 * product's tier would silently change what every existing subscriber on it is
 * entitled to, which is exactly the "entitlement from somewhere other than a
 * verified payment" that §5.10 forbids. A new tier means a new product.
 */
export async function updateSubscriptionProduct(input: {
  productId: string;
  changes: {
    name?: string;
    rollout_state?: PlanRolloutState;
    rollout_note?: string | null;
    is_active?: boolean;
    sort_order?: number;
  };
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminProductRow> {
  const existing = await prisma.subscriptionProduct.findUnique({
    where: { id: input.productId },
    select: { id: true, is_active: true, rollout_state: true },
  });

  if (!existing) {
    throw ApiError.notFound('That subscription product does not exist.');
  }

  await prisma.subscriptionProduct.update({
    where: { id: existing.id },
    data: input.changes,
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'plan.update',
    targetType: 'subscription_product',
    targetId: existing.id,
    metadata: {
      ...input.changes,
      // Recorded so an audit reader can see what it was, not only what it became.
      previous: { is_active: existing.is_active, rollout_state: existing.rollout_state },
    },
    ipAddress: input.ipAddress,
  });

  const rows = await listSubscriptionProducts();
  const updated = rows.find((row) => row.id === existing.id);

  if (!updated) {
    // Unreachable: the row was just updated inside the same request.
    throw ApiError.notFound('That subscription product does not exist.');
  }

  return updated;
}

/**
 * Publishes a new price.
 *
 * Closes the open version at the new one's start instant and opens the new one,
 * in a single transaction — so there is never a moment with two open prices
 * (which would make "the current price" ambiguous) or none (which would make
 * the paywall priceless).
 */
export async function setProductPrice(input: {
  productId: string;
  amountMinor: number;
  currency: string;
  note?: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminProductRow> {
  const product = await prisma.subscriptionProduct.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      price_versions: {
        where: { effective_to: null },
        orderBy: { effective_from: 'desc' },
        take: 1,
        select: { id: true, amount_minor: true, currency: true },
      },
    },
  });

  if (!product) {
    throw ApiError.notFound('That subscription product does not exist.');
  }

  const open = product.price_versions[0];

  if (open && open.amount_minor === input.amountMinor && open.currency === input.currency) {
    // Not an error worth failing on in principle, but creating an identical
    // version would clutter the history that exists to answer "what changed,
    // and when" — so it is refused rather than recorded as a no-op change.
    throw new ApiError(ERROR_CODES.CONFLICT, 'That is already the current price.');
  }

  const effectiveFrom = new Date();

  await prisma.$transaction(async (tx) => {
    if (open) {
      await tx.priceVersion.update({
        where: { id: open.id },
        data: { effective_to: effectiveFrom },
      });
    }

    await tx.priceVersion.create({
      data: {
        product_id: product.id,
        amount_minor: input.amountMinor,
        currency: input.currency,
        effective_from: effectiveFrom,
        note: input.note ?? null,
      },
    });
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'plan.price_set',
    targetType: 'subscription_product',
    targetId: product.id,
    metadata: {
      amount_minor: input.amountMinor,
      currency: input.currency,
      previous_amount_minor: open?.amount_minor ?? null,
      note: input.note ?? null,
    },
    ipAddress: input.ipAddress,
  });

  const rows = await listSubscriptionProducts();
  const updated = rows.find((row) => row.id === product.id);

  if (!updated) {
    throw ApiError.notFound('That subscription product does not exist.');
  }

  return updated;
}

export interface PriceHistoryEntry {
  id: string;
  amount_minor: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
}

export async function productPriceHistory(productId: string): Promise<PriceHistoryEntry[]> {
  const product = await prisma.subscriptionProduct.findUnique({
    where: { id: productId },
    select: { id: true },
  });

  if (!product) {
    throw ApiError.notFound('That subscription product does not exist.');
  }

  const versions = await prisma.priceVersion.findMany({
    where: { product_id: product.id },
    orderBy: { effective_from: 'desc' },
    select: {
      id: true,
      amount_minor: true,
      currency: true,
      effective_from: true,
      effective_to: true,
      note: true,
    },
  });

  return versions.map((version) => ({
    id: version.id,
    amount_minor: version.amount_minor,
    currency: version.currency,
    effective_from: version.effective_from.toISOString(),
    effective_to: version.effective_to?.toISOString() ?? null,
    note: version.note,
  }));
}
