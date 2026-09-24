import { API_PREFIX } from '@config/constants';
import { env } from '@config/env';
import { PaymentSource, SubscriptionStatus, SubscriptionTier, prisma } from '@/db/prisma';
import { resolveTier } from '@modules/subscriptions/subscriptions.service';
import type { AuthTokens } from '@modules/auth/auth.types';
import { addMonths } from '@utils/calendar';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { seedProducts } from '../../../prisma/seeds/products';

/**
 * Test purchases (DECISIONS.md, 24 Sep 2026): staging's stand-in for payments
 * until RevenueCat exists.
 *
 * This is the one route in the codebase that turns a request into a paid plan,
 * which spec §5.10 forbids for real purchases. So the first half of this file
 * matters more than the second: where the switch is off — everywhere real
 * users pay — the route must not exist, and a test plan must unlock nothing,
 * even one that is already in the database.
 */

const SUBS = `${API_PREFIX}/subscriptions`;
const PURCHASE = `${SUBS}/test-purchase`;

let switchWas: boolean;

beforeAll(connectRedis);

beforeEach(async () => {
  switchWas = env.TEST_PURCHASES_ENABLED;
  await resetDatabase();
  await seedEntitlements();
  await seedProducts();
});

afterEach(() => {
  env.TEST_PURCHASES_ENABLED = switchWas;
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

function switchOn(): void {
  env.TEST_PURCHASES_ENABLED = true;
}

function buy(tokens: AuthTokens, product: string) {
  return api.post(PURCHASE).set(authHeader(tokens)).send({ product });
}

function cancel(tokens: AuthTokens) {
  return api.delete(PURCHASE).set(authHeader(tokens));
}

async function livePlans(userId: string): Promise<number> {
  return prisma.subscription.count({
    where: { user_id: userId, status: SubscriptionStatus.active },
  });
}

describe('where test purchases are off — everywhere real users pay', () => {
  it('answers exactly as a path that does not exist', async () => {
    const user = await createAuthenticatedUser();

    const purchase = await buy(user.tokens, 'advanced_monthly');
    const nothing = await api
      .post(`${SUBS}/no-such-thing`)
      .set(authHeader(user.tokens))
      .send({ product: 'advanced_monthly' });

    expect(purchase.status).toBe(404);
    expect(purchase.body).toEqual(nothing.body);
    expect(await prisma.subscription.count()).toBe(0);
  });

  it('answers the cancel the same way', async () => {
    const user = await createAuthenticatedUser();

    const response = await cancel(user.tokens);
    const nothing = await api.delete(`${SUBS}/no-such-thing`).set(authHeader(user.tokens));

    expect(response.status).toBe(404);
    expect(response.body).toEqual(nothing.body);
  });

  it('tells the app there is nothing to buy with yet', async () => {
    const response = await api.get(`${SUBS}/products`);

    expect(response.body.data.purchase_mode).toBe('none');
    // The catalogue itself is unchanged: the plans can still be shown.
    expect(response.body.data.products).toHaveLength(4);
  });

  it('honours no test plan, even one already in the database', async () => {
    // A staging database restored somewhere real: the rows arrived, the
    // switch did not.
    const user = await createAuthenticatedUser();
    switchOn();
    await buy(user.tokens, 'advanced_monthly');
    env.TEST_PURCHASES_ENABLED = false;

    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.free);

    const me = await api.get(`${SUBS}/me`).set(authHeader(user.tokens));
    expect(me.body.data.tier).toBe('free');
    // Not called live either, or the app would show a plan that grants nothing.
    expect(me.body.data.subscription.is_active).toBe(false);
  });
});

describe('where test purchases are on — staging, until RevenueCat', () => {
  beforeEach(switchOn);

  it('tells the app a plan can be bought by test purchase', async () => {
    const response = await api.get(`${SUBS}/products`);

    expect(response.body.data.purchase_mode).toBe('test');
  });

  it('grants the plan at once, for a calendar month', async () => {
    const user = await createAuthenticatedUser();

    const response = await buy(user.tokens, 'advanced_monthly');

    expect(response.status).toBe(201);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.tier).toBe('advanced');

    const plan = response.body.data.subscription;
    expect(plan.source).toBe('test');
    expect(plan.product_slug).toBe('advanced_monthly');
    expect(plan.is_active).toBe(true);
    // Nothing will renew it, so it must not claim it will.
    expect(plan.auto_renew).toBe(false);
    expect(plan.current_period_end).toBe(
      addMonths(new Date(plan.current_period_start), 1).toISOString(),
    );

    // The same answer /me gives, and the tier the rest of the API now enforces.
    const me = await api.get(`${SUBS}/me`).set(authHeader(user.tokens));
    expect(me.body.data).toEqual(response.body.data);
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.advanced);

    // And the copy the admin lists read.
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.user_id },
      select: { subscription_tier: true },
    });
    expect(row.subscription_tier).toBe(SubscriptionTier.advanced);
  });

  it('runs a yearly plan for a calendar year', async () => {
    const user = await createAuthenticatedUser();

    const response = await buy(user.tokens, 'basic_yearly');
    const plan = response.body.data.subscription;

    expect(response.body.data.tier).toBe('basic');
    expect(plan.current_period_end).toBe(
      addMonths(new Date(plan.current_period_start), 12).toISOString(),
    );
  });

  it('replaces the plan it held, so switching down works', async () => {
    const user = await createAuthenticatedUser();

    await buy(user.tokens, 'advanced_yearly');
    const response = await buy(user.tokens, 'basic_monthly');

    // Left running, the old plan would win: the tier is the highest live one.
    expect(response.body.data.tier).toBe('basic');
    expect(await livePlans(user.user_id)).toBe(1);
  });

  it('ends a test plan at once, back to free', async () => {
    const user = await createAuthenticatedUser();
    await buy(user.tokens, 'advanced_monthly');

    const response = await cancel(user.tokens);

    expect(response.status).toBe(200);
    expect(response.body.data.tier).toBe('free');
    // Unlike a store cancellation, which runs to the end of the paid period:
    // nothing was paid for, and the point is to see the free tier again.
    expect(response.body.data.subscription.is_active).toBe(false);
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.free);
  });

  it('ends a staging grant the same way, since that is a test plan too', async () => {
    // As the grant of 21 Sep 2026 reads once relabelled: a year of Premium,
    // marked by its transaction id, with the test source.
    const user = await createAuthenticatedUser();
    const product = await prisma.subscriptionProduct.findUniqueOrThrow({
      where: { slug: 'advanced_yearly' },
    });
    const now = new Date();
    await prisma.subscription.create({
      data: {
        user_id: user.user_id,
        product_id: product.id,
        status: SubscriptionStatus.active,
        source: PaymentSource.test,
        original_transaction_id: `staging-grant-${user.user_id}`,
        current_period_start: now,
        current_period_end: addMonths(now, 12),
        auto_renew: false,
      },
    });
    expect(await resolveTier(user.user_id)).toBe(SubscriptionTier.advanced);

    const response = await cancel(user.tokens);

    expect(response.body.data.tier).toBe('free');
    expect(await livePlans(user.user_id)).toBe(0);
  });

  it('cancels with nothing to cancel, and says what there is', async () => {
    const user = await createAuthenticatedUser();

    const response = await cancel(user.tokens);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ tier: 'free', subscription: null });
  });

  it('never touches a subscription somebody paid for', async () => {
    const user = await createAuthenticatedUser();
    const product = await prisma.subscriptionProduct.findUniqueOrThrow({
      where: { slug: 'advanced_monthly' },
    });
    const now = new Date();
    const paid = await prisma.subscription.create({
      data: {
        user_id: user.user_id,
        product_id: product.id,
        status: SubscriptionStatus.active,
        source: PaymentSource.apple,
        original_transaction_id: `txn_${user.user_id}`,
        current_period_start: now,
        current_period_end: addMonths(now, 1),
      },
    });

    const bought = await buy(user.tokens, 'basic_monthly');
    const cancelled = await cancel(user.tokens);

    // Premium from the store the whole way through: a test plan below it
    // changes nothing, and ending the test plan ends only the test plan.
    expect(bought.body.data.tier).toBe('advanced');
    expect(cancelled.body.data.tier).toBe('advanced');

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: paid.id } });
    expect(after.status).toBe(SubscriptionStatus.active);
    expect(after.expired_at).toBeNull();
  });

  it('takes a product and nothing else — no user, no tier, no price', async () => {
    const buyer = await createAuthenticatedUser();
    const other = await createAuthenticatedUser();

    for (const extra of [
      { user_id: other.user_id },
      { tier: 'advanced' },
      { price: { amount_minor: 0, currency: 'USD' } },
    ]) {
      const response = await api
        .post(PURCHASE)
        .set(authHeader(buyer.tokens))
        .send({ product: 'basic_monthly', ...extra });

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    }

    expect(await prisma.subscription.count()).toBe(0);
  });

  it('refuses a plan that is not on sale', async () => {
    const user = await createAuthenticatedUser();
    await prisma.subscriptionProduct.update({
      where: { slug: 'basic_monthly' },
      data: { is_active: false },
    });

    for (const product of ['platinum_forever', 'basic_monthly']) {
      const response = await buy(user.tokens, product);

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
      expect(response.body.error.details.product).toEqual(['That plan is not on sale.']);
    }

    expect(await prisma.subscription.count()).toBe(0);
  });

  it('requires a token, like every other path under /subscriptions', async () => {
    const response = await api.post(PURCHASE).send({ product: 'basic_monthly' });

    expect(response.status).toBe(401);
    expect(await prisma.subscription.count()).toBe(0);
  });

  it('leaves one plan when two purchases race', async () => {
    const user = await createAuthenticatedUser();

    await Promise.all([buy(user.tokens, 'advanced_monthly'), buy(user.tokens, 'basic_monthly')]);

    // Without the lock both would end the old plan and both start a new one,
    // and the higher of the two would win whichever tap came last.
    expect(await livePlans(user.user_id)).toBe(1);
  });
});
