import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import { resolveTier } from '@modules/subscriptions/subscriptions.service';
import { seedAdminRbac } from '../../../prisma/seeds/admin-rbac';
import { seedProducts } from '../../../prisma/seeds/products';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import {
  createConversation,
  createMatch,
  createMessage,
  createUser,
  createUserWithProfile,
  createVenue,
} from '../../helpers/factories';
import { api, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';

/**
 * The admin panel's operational surfaces: moderation queue, venues, the
 * subscription catalogue, and analytics (Batch 15).
 *
 * Three things in this file matter more than the happy paths:
 *
 *   1. No endpoint returns a message somebody SENT — but the escalations view
 *      does return the complaint somebody WROTE for moderation to read. The
 *      line is between those two, not around all free text, and the first
 *      version of this module drew it in the wrong place.
 *   2. A catalogue edit grants NOBODY entitlement. spec §5.10 is the whole
 *      reason payment handling is not in this codebase, and a plan-management
 *      endpoint is the obvious place for that rule to be lost.
 *   3. `critical` severity is never dropped or scored as nothing.
 */

const ADMIN = `${API_PREFIX}/admin`;

/** An administrator: every permission, without consulting the matrix. */
async function administrator() {
  return createAuthenticatedUser({ role: 'admin' });
}

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
  await seedAdminRbac();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('moderation queue', () => {
  it('returns reports and flags in one list, tagged by source', async () => {
    const admin = await administrator();
    const reporter = await createUser();
    const offender = await createUser();

    await prisma.report.create({
      data: {
        reporter_id: reporter.id,
        reported_id: offender.id,
        reason: 'harassment',
        context_type: 'message',
      },
    });

    await prisma.moderationFlag.create({
      data: {
        subject_type: 'user',
        subject_id: offender.id,
        reason: 'scam_language',
        severity: 'critical',
      },
    });

    const response = await api.get(`${ADMIN}/moderation/queue`).set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    const body = response.body as { data: unknown };
    expect(body.data).toHaveLength(2);

    const sources = (body.data as { source: string }[]).map((row) => row.source).sort();
    expect(sources).toEqual(['flag', 'report']);
  });

  /**
   * THE PRIVACY LINE, stated precisely, because an earlier version of this
   * module drew it in the wrong place.
   *
   * What no admin endpoint may return is a message somebody SENT. A complaint
   * somebody WROTE in order to be read by moderation is the opposite case, and
   * the shipped `/reports/review` has always returned it alongside the
   * reporter's identity — so withholding it here was an inconsistency dressed
   * up as a safeguard, and it left the escalations view unbuildable.
   */
  it('never returns a message somebody sent', async () => {
    const admin = await administrator();
    const [a, b] = [await createUserWithProfile(), await createUserWithProfile()];

    const match = await createMatch(a.user.id, b.user.id, 'dating');
    const conversation = await createConversation(match.id, 'dating');
    await createMessage(conversation.id, a.user.id, 'my bank details are 1234');

    await prisma.report.create({
      data: {
        reporter_id: b.user.id,
        reported_id: a.user.id,
        reason: 'spam_scam',
        context_type: 'message',
        context_id: conversation.id,
        description: 'He asked me to move the conversation off the app.',
      },
    });

    const queue = await api.get(`${ADMIN}/moderation/queue`).set(authHeader(admin.tokens));
    const escalations = await api
      .get(`${ADMIN}/moderation/escalations`)
      .set(authHeader(admin.tokens));

    expect(queue.status).toBe(200);
    expect(escalations.status).toBe(200);

    // Asserted against the whole serialised body rather than a named field, so
    // adding a field that leaks it fails here rather than shipping.
    for (const response of [queue, escalations]) {
      expect(JSON.stringify(response.body)).not.toContain('bank details');
    }
  });

  it('keeps the queue list lean and puts the description on escalations', async () => {
    const admin = await administrator();
    const reporter = await createUser();
    const offender = await createUser();

    const complaint = 'Repeated external payment links across conversations.';

    await prisma.report.create({
      data: {
        reporter_id: reporter.id,
        reported_id: offender.id,
        reason: 'spam_scam',
        description: complaint,
      },
    });

    const queue = await api.get(`${ADMIN}/moderation/queue`).set(authHeader(admin.tokens));

    // A list of thirty rows does not need thirty paragraphs of free text; the
    // panel's queue type has no field for it either.
    expect(JSON.stringify(queue.body)).not.toContain(complaint);

    const escalations = await api
      .get(`${ADMIN}/moderation/escalations`)
      .set(authHeader(admin.tokens));

    // But the case view must have it. A reviewer holding a name and an enum
    // cannot make a decision, which is the whole point of the screen.
    expect(escalations.body.data.cases).toHaveLength(1);
    expect(escalations.body.data.cases[0].description).toBe(complaint);
  });

  it('folds critical severity up into High rather than dropping it', async () => {
    const admin = await administrator();
    const offender = await createUser();

    await prisma.moderationFlag.create({
      data: {
        subject_type: 'user',
        subject_id: offender.id,
        reason: 'payment_language',
        severity: 'critical',
      },
    });

    const response = await api
      .get(`${ADMIN}/moderation/queue?severity=High`)
      .set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    // A critical flag filtered out of the High view is the worst possible
    // failure of this screen: the most dangerous row becomes invisible.
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].severity).toBe('High');
  });

  it('assigns a flag to staff and refuses an ordinary account', async () => {
    const admin = await administrator();
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const bystander = await createUser();
    const offender = await createUser();

    const flag = await prisma.moderationFlag.create({
      data: {
        subject_type: 'user',
        subject_id: offender.id,
        reason: 'harassment',
        severity: 'high',
      },
    });

    const assigned = await api
      .patch(`${ADMIN}/moderation/flags/${flag.id}/assignee`)
      .set(authHeader(admin.tokens))
      .send({ assignee_id: moderator.user_id });

    expect(assigned.status).toBe(200);
    expect(assigned.body.data.flag.assignedToId).toBe(moderator.user_id);

    // Claiming takes it out of the unclaimed pile.
    const claimed = await prisma.moderationFlag.findUniqueOrThrow({ where: { id: flag.id } });
    expect(claimed.status).toBe('under_review');

    const refused = await api
      .patch(`${ADMIN}/moderation/flags/${flag.id}/assignee`)
      .set(authHeader(admin.tokens))
      .send({ assignee_id: bystander.id });

    // Parking a row with somebody who can never open it is worse than leaving
    // it unassigned.
    expect(refused.status).toBe(409);
  });

  it('releases a flag back to the queue on null', async () => {
    const admin = await administrator();
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const offender = await createUser();

    const flag = await prisma.moderationFlag.create({
      data: {
        subject_type: 'user',
        subject_id: offender.id,
        reason: 'spam',
        severity: 'low',
        assigned_to_id: moderator.user_id,
        status: 'under_review',
      },
    });

    const response = await api
      .patch(`${ADMIN}/moderation/flags/${flag.id}/assignee`)
      .set(authHeader(admin.tokens))
      .send({ assignee_id: null });

    expect(response.status).toBe(200);
    expect(response.body.data.flag.assignedToId).toBeNull();

    const released = await prisma.moderationFlag.findUniqueOrThrow({ where: { id: flag.id } });
    expect(released.status).toBe('open');
  });

  it('rejects an unknown field', async () => {
    const admin = await administrator();
    const offender = await createUser();

    const flag = await prisma.moderationFlag.create({
      data: {
        subject_type: 'user',
        subject_id: offender.id,
        reason: 'spam',
        severity: 'low',
      },
    });

    const response = await api
      .patch(`${ADMIN}/moderation/flags/${flag.id}/assignee`)
      .set(authHeader(admin.tokens))
      .send({ assignee_id: null, status: 'actioned' });

    // `.strict()`: resolving a flag through the assignment endpoint would skip
    // the second-review check and the notification.
    expect(response.status).toBe(400);
  });

  it('refuses a moderator who holds no moderation permission', async () => {
    const analystRole = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'analyst' } });
    const staff = await createAuthenticatedUser({ role: 'moderator' });

    await prisma.adminRoleMember.create({
      data: { user_id: staff.user_id, role_id: analystRole.id },
    });

    // The seed already denies it to an analyst. Set explicitly anyway, so this
    // test keeps asserting the refusal rather than the seed if that changes.
    await prisma.adminRolePermission.updateMany({
      where: { role_id: analystRole.id, permission: { key: 'moderation.read' } },
      data: { allowed: false },
    });

    const response = await api.get(`${ADMIN}/moderation/queue`).set(authHeader(staff.tokens));

    expect(response.status).toBe(403);
    // 403, not the block-style 404: a moderator surface is not something to
    // hide from the person holding the role (CLAUDE.md).
    expect(response.body.error.details.required_permission).toBe('moderation.read');
  });
});

describe('venues', () => {
  it('lists venues with the derived status and the honest booleans', async () => {
    const admin = await administrator();
    await createVenue();

    const response = await api.get(`${ADMIN}/venues`).set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    const row = response.body.data[0];
    expect(row).toHaveProperty('is_featured');
    expect(row).toHaveProperty('is_reviewed');
    expect(row).toHaveProperty('is_active');
    expect(['Featured', 'Pending review']).toContain(row.status);
  });

  it('creates a venue with its location set in the same commit', async () => {
    const admin = await administrator();

    const response = await api
      .post(`${ADMIN}/venues`)
      .set(authHeader(admin.tokens))
      .send({
        name: 'The Reading Room',
        category: 'study_spot',
        city: 'London',
        country: 'GB',
        modes: ['study_buddy'],
        longitude: -0.1276,
        latitude: 51.5072,
      });

    expect(response.status).toBe(201);
    // Typed in by an operator, so reviewed by definition — but never featured
    // in the same request that first described the place.
    expect(response.body.data.venue.is_reviewed).toBe(true);
    expect(response.body.data.venue.is_featured).toBe(false);

    // The location is the whole point: a venue without one is invisible to
    // every radius query while looking complete in the panel. Prisma cannot
    // read the geography column, so this asks Postgres directly.
    const rows = await prisma.$queryRaw<{ has_location: boolean }[]>`
      SELECT location IS NOT NULL AS has_location
      FROM venues WHERE id = ${response.body.data.venue.id}::uuid
    `;

    expect(rows[0]?.has_location).toBe(true);
  });

  it('refuses a venue with no coordinates or no mode', async () => {
    const admin = await administrator();

    const noCoords = await api
      .post(`${ADMIN}/venues`)
      .set(authHeader(admin.tokens))
      .send({ name: 'Nowhere In Particular', category: 'cafe', modes: ['foodie'] });

    expect(noCoords.status).toBe(400);

    const noModes = await api
      .post(`${ADMIN}/venues`)
      .set(authHeader(admin.tokens))
      .send({
        name: 'Unmatchable',
        category: 'cafe',
        modes: [],
        longitude: 0,
        latitude: 0,
      });

    // A venue matching no mode can never be suggested to anybody either.
    expect(noModes.status).toBe(400);
  });

  it('refuses coordinates outside the world', async () => {
    const admin = await administrator();

    const response = await api
      .post(`${ADMIN}/venues`)
      .set(authHeader(admin.tokens))
      .send({
        name: 'Off The Map',
        category: 'cafe',
        modes: ['foodie'],
        // Longitude and latitude the wrong way round is the classic mistake,
        // and 51.5 is a valid longitude — so this is caught by range, not order.
        longitude: 200,
        latitude: 51.5,
      });

    expect(response.status).toBe(400);
  });

  it('refuses to feature a venue nobody has reviewed', async () => {
    const admin = await administrator();
    const venue = await createVenue();

    await prisma.venue.update({ where: { id: venue.id }, data: { is_reviewed: false } });

    const response = await api
      .patch(`${ADMIN}/venues/${venue.id}`)
      .set(authHeader(admin.tokens))
      .send({ is_featured: true });

    // Featuring promotes it into the app's suggestions. Doing that to an
    // unchecked, possibly user-submitted venue is the hole this closes.
    expect(response.status).toBe(409);
  });

  it('features a venue when reviewed in the same request', async () => {
    const admin = await administrator();
    const venue = await createVenue();

    await prisma.venue.update({ where: { id: venue.id }, data: { is_reviewed: false } });

    const response = await api
      .patch(`${ADMIN}/venues/${venue.id}`)
      .set(authHeader(admin.tokens))
      .send({ is_reviewed: true, is_featured: true });

    expect(response.status).toBe(200);
    expect(response.body.data.venue.status).toBe('Featured');
  });

  it('writes an audit entry for a venue edit', async () => {
    const admin = await administrator();
    const venue = await createVenue();

    await api
      .patch(`${ADMIN}/venues/${venue.id}`)
      .set(authHeader(admin.tokens))
      .send({ name: 'The Quiet Corner' });

    const entry = await prisma.adminAuditLog.findFirst({
      where: { action: 'venue.update', target_id: venue.id },
    });

    expect(entry).not.toBeNull();
    expect(entry?.admin_id).toBe(admin.user_id);
  });

  it('404s an unknown venue and 400s an empty body', async () => {
    const admin = await administrator();

    const missing = await api
      .patch(`${ADMIN}/venues/00000000-0000-4000-8000-000000000000`)
      .set(authHeader(admin.tokens))
      .send({ name: 'Nowhere' });

    expect(missing.status).toBe(404);

    const venue = await createVenue();

    const empty = await api
      .patch(`${ADMIN}/venues/${venue.id}`)
      .set(authHeader(admin.tokens))
      .send({});

    expect(empty.status).toBe(400);
  });
});

describe('subscription catalogue', () => {
  beforeEach(async () => {
    await seedProducts();
  });

  it('lists products with their open price and subscriber count', async () => {
    const admin = await administrator();

    const response = await api
      .get(`${ADMIN}/subscription-products`)
      .set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    const plans = response.body.data.plans as {
      price: { amount_minor: number } | null;
      active_subscribers: number;
      mrr_minor: number;
    }[];

    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]!.price?.amount_minor).toBeGreaterThan(0);
    expect(plans[0]!.active_subscribers).toBe(0);
  });

  it('publishes a price as a NEW version and keeps the old one', async () => {
    const admin = await administrator();
    const product = await prisma.subscriptionProduct.findFirstOrThrow({
      where: { slug: 'basic_monthly' },
    });

    const before = await prisma.priceVersion.findFirstOrThrow({
      where: { product_id: product.id, effective_to: null },
    });

    const response = await api
      .post(`${ADMIN}/subscription-products/${product.id}/prices`)
      .set(authHeader(admin.tokens))
      .send({ amount_minor: before.amount_minor + 500, currency: before.currency });

    expect(response.status).toBe(201);

    const versions = await prisma.priceVersion.findMany({
      where: { product_id: product.id },
      orderBy: { effective_from: 'asc' },
    });

    // The old amount has to survive: it is what somebody was actually charged,
    // and it is what grandfathering and a disputed charge are answered from.
    expect(versions).toHaveLength(2);
    expect(versions[0]!.amount_minor).toBe(before.amount_minor);
    expect(versions[0]!.effective_to).not.toBeNull();

    // Exactly one open version at all times — never two, never none.
    const open = versions.filter((version) => version.effective_to === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.amount_minor).toBe(before.amount_minor + 500);
  });

  it('refuses a duplicate price and a float amount', async () => {
    const admin = await administrator();
    const product = await prisma.subscriptionProduct.findFirstOrThrow({
      where: { slug: 'basic_monthly' },
    });

    const current = await prisma.priceVersion.findFirstOrThrow({
      where: { product_id: product.id, effective_to: null },
    });

    const duplicate = await api
      .post(`${ADMIN}/subscription-products/${product.id}/prices`)
      .set(authHeader(admin.tokens))
      .send({ amount_minor: current.amount_minor, currency: current.currency });

    expect(duplicate.status).toBe(409);

    const float = await api
      .post(`${ADMIN}/subscription-products/${product.id}/prices`)
      .set(authHeader(admin.tokens))
      .send({ amount_minor: 9.99, currency: 'GBP' });

    // spec §4.6: money is integer minor units. A float here is how a price
    // becomes 9.989999999 three systems downstream.
    expect(float.status).toBe(400);
  });

  it('returns price history newest first', async () => {
    const admin = await administrator();
    const product = await prisma.subscriptionProduct.findFirstOrThrow({
      where: { slug: 'advanced_yearly' },
    });

    await api
      .post(`${ADMIN}/subscription-products/${product.id}/prices`)
      .set(authHeader(admin.tokens))
      .send({ amount_minor: 1234, currency: 'GBP' });

    const response = await api
      .get(`${ADMIN}/subscription-products/${product.id}/prices`)
      .set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.versions[0].amount_minor).toBe(1234);
    expect(response.body.data.versions[0].effective_to).toBeNull();
  });

  it('cannot change a product tier or billing cycle', async () => {
    const admin = await administrator();
    const product = await prisma.subscriptionProduct.findFirstOrThrow({
      where: { slug: 'basic_monthly' },
    });

    const response = await api
      .patch(`${ADMIN}/subscription-products/${product.id}`)
      .set(authHeader(admin.tokens))
      .send({ tier: 'advanced' });

    // `.strict()`. Flipping a product's tier would change what every existing
    // subscriber on it is entitled to, with no payment anywhere — exactly the
    // thing spec §5.10 forbids.
    expect(response.status).toBe(400);
  });

  /**
   * THE RULE THE WHOLE CATALOGUE SURFACE EXISTS UNDER.
   *
   * Payment processing is not in this codebase, so no HTTP route may grant
   * access. A plan-management screen is the single most likely place for that
   * to be forgotten, which is why it is asserted rather than assumed.
   */
  it('grants NOBODY entitlement, however the catalogue is edited', async () => {
    const admin = await administrator();
    const subject = await createUser();

    expect(await resolveTier(subject.id)).toBe('free');

    const product = await prisma.subscriptionProduct.findFirstOrThrow({
      where: { slug: 'advanced_monthly' },
    });

    await api
      .patch(`${ADMIN}/subscription-products/${product.id}`)
      .set(authHeader(admin.tokens))
      .send({ rollout_state: 'promo', is_active: true, name: 'Everything Free Forever' });

    await api
      .post(`${ADMIN}/subscription-products/${product.id}/prices`)
      .set(authHeader(admin.tokens))
      .send({ amount_minor: 0, currency: 'GBP' });

    // A free price in the catalogue is a catalogue entry, not an entitlement.
    expect(await resolveTier(subject.id)).toBe('free');
    expect(await prisma.subscription.count()).toBe(0);
  });

  it('requires the catalogue write permission, not just staff status', async () => {
    const moderatorRole = await prisma.adminRole.findUniqueOrThrow({
      where: { key: 'moderator' },
    });
    const staff = await createAuthenticatedUser({ role: 'moderator' });

    await prisma.adminRoleMember.create({
      data: { user_id: staff.user_id, role_id: moderatorRole.id },
    });

    const product = await prisma.subscriptionProduct.findFirstOrThrow({
      where: { slug: 'basic_monthly' },
    });

    const response = await api
      .patch(`${ADMIN}/subscription-products/${product.id}`)
      .set(authHeader(staff.tokens))
      .send({ rollout_state: 'draft' });

    expect(response.status).toBe(403);
    expect(response.body.error.details.required_permission).toBe('subscriptions.write');
  });
});

describe('analytics', () => {
  it('returns every series with a basis, and no mock values', async () => {
    const admin = await administrator();

    const response = await api.get(`${ADMIN}/analytics`).set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    const body = response.body as { data: unknown };
    const data = body.data as Record<string, { basis: string; points: unknown[] }>;

    for (const key of [
      'engagement',
      'weeklyResolution',
      'subscriptionMix',
      'revenuePulse',
      'churnByBilling',
      'modePerformance',
      'acquisitionChannels',
    ]) {
      // An operator is about to make a decision with each of these numbers and
      // is entitled to know what they actually count.
      expect(typeof data[key]!.basis).toBe('string');
      expect(data[key]!.basis.length).toBeGreaterThan(10);
      expect(Array.isArray(data[key]!.points)).toBe(true);
    }
  });

  it('reports all eight modes, including the ones nobody uses', async () => {
    const admin = await administrator();

    const response = await api.get(`${ADMIN}/analytics`).set(authHeader(admin.tokens));

    // A mode with zero users is a real and useful answer; dropping it would
    // hide exactly the thing worth seeing.
    expect(response.body.data.modePerformance.points).toHaveLength(8);
  });

  it('counts a user once however many identities they have linked', async () => {
    const admin = await administrator();
    const user = await createUser();

    await prisma.authIdentity.create({
      data: { user_id: user.id, provider: 'google', identifier: `g-${user.id}` },
    });

    const response = await api.get(`${ADMIN}/analytics`).set(authHeader(admin.tokens));

    const channels = response.body.data.acquisitionChannels.points as { users: number }[];
    const total = channels.reduce((sum, row) => sum + row.users, 0);

    // Counting identities rather than users would make the shares sum past
    // 100% as soon as anybody links a second sign-in method.
    expect(total).toBe(await prisma.user.count({ where: { role: 'user', deleted_at: null } }));
  });

  it('is empty-safe on a database with no subscriptions at all', async () => {
    const admin = await administrator();

    const response = await api.get(`${ADMIN}/analytics`).set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    // Every rate divides by a count that can be zero. A dashboard that 500s on
    // a quiet day is a dashboard nobody trusts.
    const pulse = response.body.data.revenuePulse.points as { percent: number | null }[];
    for (const metric of pulse) {
      expect(metric.percent === null || Number.isFinite(metric.percent)).toBe(true);
    }
  });

  it('refuses staff without the analytics permission', async () => {
    const moderatorRole = await prisma.adminRole.findUniqueOrThrow({
      where: { key: 'moderator' },
    });
    const staff = await createAuthenticatedUser({ role: 'moderator' });

    await prisma.adminRoleMember.create({
      data: { user_id: staff.user_id, role_id: moderatorRole.id },
    });

    const response = await api.get(`${ADMIN}/analytics`).set(authHeader(staff.tokens));

    expect(response.status).toBe(403);
  });
});

describe('moderation escalations', () => {
  it('orders by severity first, then oldest within the band', async () => {
    const admin = await administrator();
    const reporter = await createUser();
    const high = await createUser();
    const medium = await createUser();

    // The Medium is OLDER, so a plain oldest-first ordering would put it on
    // top and bury the High — the failure this ordering exists to prevent.
    await prisma.report.create({
      data: {
        reporter_id: reporter.id,
        reported_id: medium.id,
        reason: 'spam_scam',
        created_at: new Date('2026-01-01T00:00:00Z'),
      },
    });

    await prisma.report.create({
      data: {
        reporter_id: reporter.id,
        reported_id: high.id,
        reason: 'safety_concern',
        created_at: new Date('2026-06-01T00:00:00Z'),
      },
    });

    const response = await api
      .get(`${ADMIN}/moderation/escalations`)
      .set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
    const cases = response.body.data.cases as { severity: string; userId: string }[];

    expect(cases[0]!.severity).toBe('High');
    expect(cases[0]!.userId).toBe(high.id);
    expect(cases[1]!.severity).toBe('Medium');
  });

  it('excludes Low severity entirely', async () => {
    const admin = await administrator();
    const reporter = await createUser();
    const offender = await createUser();

    // `fake_profile` infers to Low. Padding a priority list with cases that
    // can wait turns it into the ordinary queue with a different title.
    await prisma.report.create({
      data: { reporter_id: reporter.id, reported_id: offender.id, reason: 'fake_profile' },
    });

    const response = await api
      .get(`${ADMIN}/moderation/escalations`)
      .set(authHeader(admin.tokens));

    expect(response.body.data.cases).toEqual([]);
  });

  it('gives an automated flag a null description rather than an invented one', async () => {
    const admin = await administrator();
    const offender = await createUser();

    await prisma.moderationFlag.create({
      data: {
        subject_type: 'user',
        subject_id: offender.id,
        reason: 'scam_language',
        severity: 'critical',
      },
    });

    const response = await api
      .get(`${ADMIN}/moderation/escalations`)
      .set(authHeader(admin.tokens));

    const flagCase = response.body.data.cases[0];

    expect(flagCase.source).toBe('flag');
    // A generated sentence reads to a reviewer exactly like something a person
    // wrote, and they would weigh it as evidence.
    expect(flagCase.description).toBeNull();
    // `critical` folds up into High here too, not dropped for being off-scale.
    expect(flagCase.severity).toBe('High');
  });

  it('ignores resolved cases and refuses without the permission', async () => {
    const admin = await administrator();
    const reporter = await createUser();
    const offender = await createUser();

    await prisma.report.create({
      data: {
        reporter_id: reporter.id,
        reported_id: offender.id,
        reason: 'harassment',
        status: 'actioned',
        reviewed_at: new Date(),
      },
    });

    const judged = await api
      .get(`${ADMIN}/moderation/escalations`)
      .set(authHeader(admin.tokens));

    // A judged report must not sit in the escalation list for ever.
    expect(judged.body.data.cases).toEqual([]);

    const analystRole = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'analyst' } });
    const staff = await createAuthenticatedUser({ role: 'moderator' });

    await prisma.adminRoleMember.create({
      data: { user_id: staff.user_id, role_id: analystRole.id },
    });

    const refused = await api
      .get(`${ADMIN}/moderation/escalations`)
      .set(authHeader(staff.tokens));

    expect(refused.status).toBe(403);
  });

  it('validates the limit', async () => {
    const admin = await administrator();

    const response = await api
      .get(`${ADMIN}/moderation/escalations?limit=500`)
      .set(authHeader(admin.tokens));

    expect(response.status).toBe(400);
  });
});
