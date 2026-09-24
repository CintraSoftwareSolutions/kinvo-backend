import { API_PREFIX } from '@config/constants';
import { PaymentSource, SubscriptionStatus, SubscriptionTier, prisma } from '@/db/prisma';
import {
  resolveTier,
  sweepExpiredSubscriptions,
} from '@modules/subscriptions/subscriptions.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { seedProducts } from '../../../prisma/seeds/products';

/**
 * Subscriptions (spec §5.10).
 *
 * THE RULE, quoted because every test below exists to enforce it:
 *
 *   "Never grant entitlement from a client claim alone. A client-trusting
 *    implementation is trivially exploitable and will be exploited."
 *
 * Purchasing lives outside this codebase, so the strongest guarantee this
 * module can make is that NOTHING reachable over HTTP grants access, and that
 * what does grant it is a subscription row rather than an editable column.
 * Both are asserted directly.
 */

const SUBS = `${API_PREFIX}/subscriptions`;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Creates a subscription row the way one really arrives: written to the
 * database, not requested by a client.
 *
 * Deliberately NOT routed through any service function. There is no code path
 * from a request to a subscription row, and a test helper that invented one
 * would be testing a door that does not exist.
 */
async function giveSubscription(
  userId: string,
  slug = 'advanced_monthly',
  overrides: Partial<{
    status: SubscriptionStatus;
    current_period_end: Date;
    refunded_at: Date | null;
    revoked_at: Date | null;
    auto_renew: boolean;
  }> = {},
) {
  const product = await prisma.subscriptionProduct.findUniqueOrThrow({ where: { slug } });
  const now = new Date();

  return prisma.subscription.create({
    data: {
      user_id: userId,
      product_id: product.id,
      status: SubscriptionStatus.active,
      source: PaymentSource.apple,
      original_transaction_id: `txn_${slug}_${userId}`,
      current_period_start: now,
      current_period_end: new Date(now.getTime() + THIRTY_DAYS_MS),
      auto_renew: true,
      ...overrides,
    },
  });
}

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
  await seedProducts();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('GET /subscriptions/products', () => {
  it('lists the four products with prices in minor units', async () => {
    const response = await api.get(`${SUBS}/products`);

    expectSuccessEnvelope(response.body);
    expect(response.body.data.products).toHaveLength(4);

    const monthly = response.body.data.products.find(
      (product: { slug: string }) => product.slug === 'advanced_monthly',
    );

    // spec §4.6: integer minor units plus a currency. Never a float, never a
    // formatted string.
    expect(monthly.price.amount_minor).toBe(1999);
    expect(monthly.price.currency).toBe('USD');
    expect(Number.isInteger(monthly.price.amount_minor)).toBe(true);
  });

  it('says what each plan adds over free, from the entitlement matrix', async () => {
    const response = await api.get(`${SUBS}/products`);
    const featuresOf = (slug: string): string[] =>
      response.body.data.products.find((product: { slug: string }) => product.slug === slug)
        .features;

    expect(featuresOf('basic_monthly')).toContain('Unlimited likes');
    expect(featuresOf('basic_monthly')).not.toContain('See who liked you');
    expect(featuresOf('advanced_monthly')).toContain('See who liked you');
    // Monthly and yearly are the same plan, paid differently.
    expect(featuresOf('advanced_yearly')).toEqual(featuresOf('advanced_monthly'));
  });

  it('follows the matrix when a feature moves between tiers, with no release', async () => {
    // Open decision #2 still decides who sees their likes. Answering it is a
    // seed edit; the paywall must tell the truth the moment it is made.
    const flag = await prisma.entitlementFlag.findUniqueOrThrow({
      where: { key: 'see_who_liked_you' },
    });
    await prisma.tierEntitlement.update({
      where: { tier_flag_id: { tier: SubscriptionTier.basic, flag_id: flag.id } },
      data: { value: true },
    });

    const response = await api.get(`${SUBS}/products`);
    const basic = response.body.data.products.find(
      (product: { slug: string }) => product.slug === 'basic_monthly',
    );

    expect(basic.features).toContain('See who liked you');
  });

  it('is readable without a token, because the paywall is shown early', async () => {
    const response = await api.get(`${SUBS}/products`);

    expect(response.status).toBe(200);
  });
});

describe('nothing reachable over HTTP can grant entitlement (spec §5.10)', () => {
  /**
   * The purchase endpoints are GONE, not disabled.
   *
   * Asserted rather than assumed: a 404 here is what proves there is no server
   * route that turns a request into access. If any of these ever answers
   * something else, a path to granting entitlement has reappeared.
   */
  it.each([
    `${SUBS}/checkout`,
    `${SUBS}/portal`,
    `${SUBS}/restore`,
    // Staging's stand-in for payments exists only where test purchases are
    // switched on, and they are off by default, as everywhere real users pay.
    // test-purchases.test.ts covers both states.
    `${SUBS}/test-purchase`,
    // No PAYMENT webhook. The namespace itself is no longer empty — the video
    // provider's status callback lives at /webhooks/video — so this asserts the
    // specific paths a payment provider would post to, rather than the whole
    // prefix. A callback that ends a video call cannot grant entitlement; one
    // that reports a purchase could, and there is none.
    `${API_PREFIX}/webhooks/stripe`,
    `${API_PREFIX}/webhooks/apple`,
    `${API_PREFIX}/webhooks/google`,
    `${API_PREFIX}/webhooks/revenuecat`,
  ])('POST %s does not exist', async (path) => {
    const user = await createAuthenticatedUser();

    const response = await api
      .post(path)
      .set(authHeader(user.tokens))
      .send({ product_slug: 'advanced_monthly', tier: 'advanced' });

    expect(response.status).toBe(404);
  });

  it('the one webhook that does exist cannot touch entitlement', async () => {
    const user = await createAuthenticatedUser();

    const before = await api.get(`${API_PREFIX}/me/entitlements`).set(authHeader(user.tokens));

    // Unsigned, and carrying every field a forger might hope means something.
    const response = await api.post(`${API_PREFIX}/webhooks/video`).send({
      StatusCallbackEvent: 'room-ended',
      RoomName: 'kinvo-call-anything',
      tier: 'advanced',
      product_slug: 'advanced_yearly',
    });

    // Refused for want of a signature, and the tier is untouched either way.
    expect(response.status).toBe(403);

    const after = await api.get(`${API_PREFIX}/me/entitlements`).set(authHeader(user.tokens));
    expect(after.body.data.tier).toBe(before.body.data.tier);
    expect(after.body.data.tier).toBe('free');
  });

  it('ignores the denormalised tier column entirely', async () => {
    const user = await createAuthenticatedUser();

    // The column exists for admin lists. Someone editing it — by hand, by a
    // careless admin action, by a bad migration — must not gain a paid feature.
    await prisma.user.update({
      where: { id: user.user_id },
      data: { subscription_tier: SubscriptionTier.advanced },
    });

    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.free);

    const response = await api.get(`${API_PREFIX}/me/entitlements`).set(authHeader(user.tokens));

    expect(response.body.data.tier).toBe('free');
    expect(response.body.data.flags.see_who_liked_you).toBe(false);
  });

  it('grants from a subscription row, and only from that', async () => {
    const user = await createAuthenticatedUser();

    await giveSubscription(user.user_id);

    const response = await api.get(`${API_PREFIX}/me/entitlements`).set(authHeader(user.tokens));

    expect(response.body.data.tier).toBe('advanced');
    expect(response.body.data.flags.see_who_liked_you).toBe(true);
    // -1 is unlimited, so an advanced user is not silently capped at the free
    // allowance.
    expect(response.body.data.flags.daily_swipe_limit).toBe(-1);
  });
});

describe('the lifecycle (spec §5.10)', () => {
  it('keeps access after cancellation until the period ends', async () => {
    const user = await createAuthenticatedUser();
    await giveSubscription(user.user_id, 'advanced_monthly', {
      status: SubscriptionStatus.cancelled,
      auto_renew: false,
    });

    // Cancelling means "do not renew". They have already paid for the rest of
    // the month, and cutting them off would be taking money for nothing.
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.advanced);
  });

  it('keeps access while billing retries', async () => {
    const user = await createAuthenticatedUser();
    await giveSubscription(user.user_id, 'advanced_monthly', {
      status: SubscriptionStatus.on_billing_retry,
    });

    // A card that needed reissuing must not cost the customer AND the payment.
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.advanced);
  });

  it('keeps access during a grace period', async () => {
    const user = await createAuthenticatedUser();
    await giveSubscription(user.user_id, 'advanced_monthly', {
      status: SubscriptionStatus.in_grace_period,
    });

    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.advanced);
  });

  it('REVOKES access on refund, immediately', async () => {
    const user = await createAuthenticatedUser();
    const now = new Date();

    await giveSubscription(user.user_id, 'advanced_monthly', {
      status: SubscriptionStatus.refunded,
      refunded_at: now,
      revoked_at: now,
    });

    // spec §5.10: a refunded user keeping premium is a straightforward revenue
    // leak. Not at period end — now.
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.free);
  });

  it('ends access when the paid period lapses, with no job needed', async () => {
    const user = await createAuthenticatedUser();
    await giveSubscription(user.user_id, 'advanced_monthly', {
      current_period_end: new Date(Date.now() - 1000),
    });

    // The sweep is bookkeeping; entitlement checks the period directly, so a
    // late job cannot hand out free premium.
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.free);
  });

  it('takes the higher tier when two subscriptions overlap on upgrade', async () => {
    const user = await createAuthenticatedUser();

    await giveSubscription(user.user_id, 'basic_monthly');
    await giveSubscription(user.user_id, 'advanced_monthly');

    // Mid-period upgrades leave both rows briefly. The answer must be the
    // better one, not whichever the database returned first.
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.advanced);
  });

  it('marks lapsed subscriptions expired when the sweep runs', async () => {
    const user = await createAuthenticatedUser();
    await giveSubscription(user.user_id, 'advanced_monthly', {
      current_period_end: new Date(Date.now() - 1000),
    });

    expect(await sweepExpiredSubscriptions()).toBe(1);
    expect((await prisma.subscription.findFirstOrThrow()).status).toBe(SubscriptionStatus.expired);
  });
});

describe('entitlement belongs to the USER (spec §5.10)', () => {
  it('resolves for the same user on a different device or session', async () => {
    const user = await createAuthenticatedUser({ email: 'carryover@example.com' });

    await giveSubscription(user.user_id);

    // A second sign-in is a different session entirely — the subscription is
    // keyed on user_id, so it carries.
    const second = await api
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: 'carryover@example.com', password: 'correct horse battery staple' });

    const response = await api
      .get(`${API_PREFIX}/me/entitlements`)
      .set(authHeader(second.body.data));

    expect(response.body.data.tier).toBe('advanced');
  });

  it('never leaks one user’s subscription to another', async () => {
    const paying = await createAuthenticatedUser();
    const other = await createAuthenticatedUser();

    await giveSubscription(paying.user_id);

    const response = await api.get(`${SUBS}/me`).set(authHeader(other.tokens));

    expect(response.body.data.tier).toBe('free');
    expect(response.body.data.subscription).toBeNull();
  });
});

describe('GET /subscriptions/me', () => {
  it('returns the subscription and whether it is live', async () => {
    const user = await createAuthenticatedUser();
    await giveSubscription(user.user_id);

    const response = await api.get(`${SUBS}/me`).set(authHeader(user.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.tier).toBe('advanced');
    expect(response.body.data.subscription.is_active).toBe(true);
    expect(response.body.data.subscription.auto_renew).toBe(true);
    // spec §4.6: UTC ISO-8601 with Z.
    expect(response.body.data.subscription.current_period_end).toMatch(/Z$/);
  });

  it('reports is_active false once the period has lapsed', async () => {
    const user = await createAuthenticatedUser();
    await giveSubscription(user.user_id, 'advanced_monthly', {
      current_period_end: new Date(Date.now() - 1000),
    });

    const response = await api.get(`${SUBS}/me`).set(authHeader(user.tokens));

    // The row is still returned — the app shows billing history — but the app
    // must read is_active rather than inferring from the status label.
    expect(response.body.data.subscription).not.toBeNull();
    expect(response.body.data.subscription.is_active).toBe(false);
    expect(response.body.data.tier).toBe('free');
  });

  it('returns null, never an omitted key, with no subscription', async () => {
    const user = await createAuthenticatedUser();

    const response = await api.get(`${SUBS}/me`).set(authHeader(user.tokens));

    expect(response.body.data.subscription).toBeNull();
    expect(response.body.data.tier).toBe('free');
  });

  it('requires a token', async () => {
    const response = await api.get(`${SUBS}/me`);

    expect(response.status).toBe(401);
  });
});
