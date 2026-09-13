import { Mode, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  adultDateOfBirth,
  createBlock,
  createConversation,
  createMatch,
  createMessage,
  createSwipe,
  createUser,
  createUserWithProfile,
  uniqueEmail,
} from '../helpers/factories';

/**
 * These tests exist to prove the schema enforces the spec's rules, rather than
 * trusting that it does. Every assertion here maps to a sentence in
 * KINVO_BACKEND_BUILD.md.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('mode scoping — the core architectural rule (spec §1, §5.3)', () => {
  it('lets the same pair swipe independently in different modes', async () => {
    const sarah = await createUser({ display_name: 'Sarah' });
    const tom = await createUser({ display_name: 'Tom' });

    await createSwipe(sarah.id, tom.id, Mode.study_buddy, 'like');
    await createSwipe(sarah.id, tom.id, Mode.dating, 'pass');

    const swipes = await prisma.swipe.findMany({ where: { actor_id: sarah.id } });

    expect(swipes).toHaveLength(2);
    expect(swipes.map((s) => s.mode).sort()).toEqual(['dating', 'study_buddy']);
    expect(swipes.find((s) => s.mode === Mode.study_buddy)?.action).toBe('like');
    expect(swipes.find((s) => s.mode === Mode.dating)?.action).toBe('pass');
  });

  it('rejects a second swipe on the same pair in the same mode', async () => {
    const sarah = await createUser();
    const tom = await createUser();

    await createSwipe(sarah.id, tom.id, Mode.dating, 'like');

    await expect(createSwipe(sarah.id, tom.id, Mode.dating, 'pass')).rejects.toThrow(
      /unique|constraint/i,
    );
  });

  it('treats a swipe as directional — B may still swipe on A', async () => {
    const sarah = await createUser();
    const tom = await createUser();

    await createSwipe(sarah.id, tom.id, Mode.dating, 'like');
    const reverse = await createSwipe(tom.id, sarah.id, Mode.dating, 'like');

    expect(reverse.id).toBeDefined();
  });

  it('rejects a swipe on yourself', async () => {
    const sarah = await createUser();

    await expect(createSwipe(sarah.id, sarah.id, Mode.dating)).rejects.toThrow(
      /swipes_not_self_check|constraint/i,
    );
  });

  it('lets one pair hold simultaneous matches in different modes', async () => {
    const sarah = await createUser();
    const tom = await createUser();

    const dating = await createMatch(sarah.id, tom.id, Mode.dating);
    const study = await createMatch(sarah.id, tom.id, Mode.study_buddy);

    expect(dating.id).not.toBe(study.id);
    expect(dating.mode).toBe('dating');
    expect(study.mode).toBe('study_buddy');

    const all = await prisma.match.findMany();
    expect(all).toHaveLength(2);
  });

  it('rejects a duplicate match for the same pair in the same mode', async () => {
    const sarah = await createUser();
    const tom = await createUser();

    await createMatch(sarah.id, tom.id, Mode.dating);

    await expect(createMatch(sarah.id, tom.id, Mode.dating)).rejects.toThrow(/unique|constraint/i);
  });

  it('cannot be bypassed by swapping the user columns', async () => {
    const [first, second] = [(await createUser()).id, (await createUser()).id].sort();

    await createMatch(first!, second!, Mode.dating);

    // Writing the pair the other way round must be refused by the CHECK
    // constraint, not silently accepted as a second match.
    const expiresAt = new Date(Date.now() + 86_400_000);
    await expect(
      prisma.match.create({
        data: { user_a_id: second!, user_b_id: first!, mode: Mode.dating, expires_at: expiresAt },
      }),
    ).rejects.toThrow(/matches_user_order_check|constraint/i);
  });

  it('rejects a match with yourself', async () => {
    const sarah = await createUser();
    const expiresAt = new Date(Date.now() + 86_400_000);

    await expect(
      prisma.match.create({
        data: {
          user_a_id: sarah.id,
          user_b_id: sarah.id,
          mode: Mode.dating,
          expires_at: expiresAt,
        },
      }),
    ).rejects.toThrow(/constraint/i);
  });

  it('gives a conversation exactly one match, and its mode (spec §5.4, decision #5)', async () => {
    const sarah = await createUser();
    const tom = await createUser();
    const match = await createMatch(sarah.id, tom.id, Mode.foodie);

    const conversation = await createConversation(match.id, Mode.foodie);

    expect(conversation.match_id).toBe(match.id);
    expect(conversation.mode).toBe('foodie');

    // One conversation per match — match_id is unique.
    await expect(createConversation(match.id, Mode.foodie)).rejects.toThrow(/unique|constraint/i);
  });
});

describe('identity (spec §5.1)', () => {
  it('stores date of birth, never an age integer', async () => {
    const user = await createUser({ date_of_birth: adultDateOfBirth(27) });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(stored.date_of_birth).toBeInstanceOf(Date);
    expect(Object.keys(stored)).not.toContain('age');
  });

  it('refuses to let one identifier belong to two users', async () => {
    const email = uniqueEmail('shared');
    await createUser({ email });

    await expect(createUser({ email })).rejects.toThrow(/unique|constraint/i);
  });

  it('lets one user hold several identities across providers', async () => {
    const user = await createUser({ email: 'linked@kinvo.test' });

    await prisma.authIdentity.create({
      data: { user_id: user.id, provider: 'google', identifier: 'google-subject-123' },
    });
    await prisma.authIdentity.create({
      data: { user_id: user.id, provider: 'apple', identifier: 'apple-subject-456' },
    });

    const identities = await prisma.authIdentity.findMany({ where: { user_id: user.id } });
    expect(identities).toHaveLength(3);
  });

  it('defaults a new user to pending, not active (spec §5.1 state machine)', async () => {
    const user = await prisma.user.create({
      data: { display_name: 'Fresh', date_of_birth: adultDateOfBirth() },
    });

    expect(user.status).toBe('pending');
    expect(user.subscription_tier).toBe('free');
    expect(user.role).toBe('user');
  });

  it('issues UUID v4 identifiers, never sequential integers (spec §4.6)', async () => {
    const user = await createUser();
    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps snooze separate from status so matches survive it (spec §5.6)', async () => {
    const user = await createUser({ is_snoozed: true });

    expect(user.status).toBe('active');
    expect(user.is_snoozed).toBe(true);
    expect(user.snooze_ends_at).toBeNull();
  });
});

describe('per-mode preferences (spec §5.2)', () => {
  it('stores preferences once per (user, mode)', async () => {
    const user = await createUser();

    await prisma.userMode.create({
      data: { user_id: user.id, mode: Mode.cuddle, is_enabled: true, radius_metres: 5000 },
    });
    await prisma.userMode.create({
      data: { user_id: user.id, mode: Mode.networking, is_enabled: true, radius_metres: 80000 },
    });

    const modes = await prisma.userMode.findMany({ where: { user_id: user.id } });

    expect(modes).toHaveLength(2);
    expect(modes.find((m) => m.mode === Mode.cuddle)?.radius_metres).toBe(5000);
    expect(modes.find((m) => m.mode === Mode.networking)?.radius_metres).toBe(80000);
  });

  it('rejects a duplicate row for the same user and mode', async () => {
    const user = await createUser();
    await prisma.userMode.create({ data: { user_id: user.id, mode: Mode.dating } });

    await expect(
      prisma.userMode.create({ data: { user_id: user.id, mode: Mode.dating } }),
    ).rejects.toThrow(/unique|constraint/i);
  });

  it('allows only one primary mode per user', async () => {
    const user = await createUser();
    await prisma.userMode.create({
      data: { user_id: user.id, mode: Mode.dating, is_primary: true },
    });

    await expect(
      prisma.userMode.create({ data: { user_id: user.id, mode: Mode.fitness, is_primary: true } }),
    ).rejects.toThrow(/user_modes_primary_unique|unique|constraint/i);
  });

  it('refuses an age range that would reach below 18', async () => {
    const user = await createUser();

    await expect(
      prisma.userMode.create({ data: { user_id: user.id, mode: Mode.dating, min_age: 16 } }),
    ).rejects.toThrow(/user_modes_age_range_check|constraint/i);
  });

  it('refuses an inverted age range', async () => {
    const user = await createUser();

    await expect(
      prisma.userMode.create({
        data: { user_id: user.id, mode: Mode.dating, min_age: 40, max_age: 30 },
      }),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses a non-positive radius', async () => {
    const user = await createUser();

    await expect(
      prisma.userMode.create({ data: { user_id: user.id, mode: Mode.dating, radius_metres: 0 } }),
    ).rejects.toThrow(/user_modes_radius_check|constraint/i);
  });

  it('defaults the radius in metres, not miles (spec §4.6)', async () => {
    const user = await createUser();
    const userMode = await prisma.userMode.create({
      data: { user_id: user.id, mode: Mode.dating },
    });

    // ~30 miles. A miles-based default would be a two-digit number.
    expect(userMode.radius_metres).toBeGreaterThan(1000);
  });
});

describe('photos (spec §7 Batch 4)', () => {
  async function makeProfile() {
    const { profile } = await createUserWithProfile();
    return profile;
  }

  function photoData(profileId: string, position: number, isPrimary = false) {
    return {
      profile_id: profileId,
      s3_bucket: 'kinvo-media-test',
      s3_key: `photos/${profileId}/${position}.jpg`,
      url: `https://cdn.kinvo.test/${profileId}/${position}.jpg`,
      position,
      is_primary: isPrimary,
    };
  }

  it('refuses two live photos in the same position', async () => {
    const profile = await makeProfile();
    await prisma.photo.create({ data: photoData(profile.id, 0) });

    await expect(prisma.photo.create({ data: photoData(profile.id, 0) })).rejects.toThrow(
      /unique|constraint/i,
    );
  });

  it('frees the position again once a photo is soft-deleted', async () => {
    const profile = await makeProfile();
    const first = await prisma.photo.create({ data: photoData(profile.id, 0) });

    await prisma.photo.update({ where: { id: first.id }, data: { deleted_at: new Date() } });

    const replacement = await prisma.photo.create({ data: photoData(profile.id, 0) });
    expect(replacement.id).not.toBe(first.id);

    // Soft delete, not hard: the original row survives for audit.
    const original = await prisma.photo.findUnique({ where: { id: first.id } });
    expect(original).not.toBeNull();
    expect(original?.deleted_at).toBeInstanceOf(Date);
  });

  it('allows only one primary photo per profile', async () => {
    const profile = await makeProfile();
    await prisma.photo.create({ data: photoData(profile.id, 0, true) });

    await expect(prisma.photo.create({ data: photoData(profile.id, 1, true) })).rejects.toThrow(
      /unique|constraint/i,
    );
  });

  it('refuses a position outside the six-photo range', async () => {
    const profile = await makeProfile();

    await expect(prisma.photo.create({ data: photoData(profile.id, 6) })).rejects.toThrow(
      /photos_position_range_check|constraint/i,
    );
  });

  it('defaults new media to pending moderation (spec §4.8)', async () => {
    const profile = await makeProfile();
    const photo = await prisma.photo.create({ data: photoData(profile.id, 0) });

    expect(photo.moderation_status).toBe('pending');
  });
});

describe('safety (spec §5.5, §5.7)', () => {
  it('records a block in one direction and refuses duplicates', async () => {
    const a = await createUser();
    const b = await createUser();

    await createBlock(a.id, b.id);

    await expect(createBlock(a.id, b.id)).rejects.toThrow(/unique|constraint/i);

    // The reverse direction is a separate fact and is allowed.
    const reverse = await createBlock(b.id, a.id);
    expect(reverse.id).toBeDefined();
  });

  it('refuses a self-block', async () => {
    const a = await createUser();
    await expect(createBlock(a.id, a.id)).rejects.toThrow(/blocks_not_self_check|constraint/i);
  });

  it('refuses a self-report', async () => {
    const a = await createUser();

    await expect(
      prisma.report.create({
        data: { reporter_id: a.id, reported_id: a.id, reason: 'harassment' },
      }),
    ).rejects.toThrow(/reports_not_self_check|constraint/i);
  });

  it('keeps the reporter on the row but never on the reported user (spec §5.7)', async () => {
    const reporter = await createUser();
    const reported = await createUser();

    await prisma.report.create({
      data: { reporter_id: reporter.id, reported_id: reported.id, reason: 'spam_scam' },
    });

    // Anonymity is an API-layer guarantee. What the schema must ensure is that
    // nothing hangs off the reported user that would reveal the reporter.
    const asSeenByReported = await prisma.user.findUniqueOrThrow({
      where: { id: reported.id },
      include: { reports_received: { select: { id: true, reason: true, created_at: true } } },
    });

    expect(asSeenByReported.reports_received).toHaveLength(1);
    expect(JSON.stringify(asSeenByReported)).not.toContain(reporter.id);
  });
});

describe('soft deletes (spec §7 Batch 1)', () => {
  it('preserves users, messages and reports as rows', async () => {
    const sender = await createUser();
    const other = await createUser();
    const match = await createMatch(sender.id, other.id, Mode.dating);
    const conversation = await createConversation(match.id, Mode.dating);
    const message = await createMessage(conversation.id, sender.id);
    const report = await prisma.report.create({
      data: { reporter_id: sender.id, reported_id: other.id, reason: 'harassment' },
    });

    const now = new Date();
    await prisma.user.update({ where: { id: other.id }, data: { deleted_at: now } });
    await prisma.message.update({ where: { id: message.id }, data: { deleted_at: now } });
    await prisma.report.update({ where: { id: report.id }, data: { deleted_at: now } });

    expect(await prisma.user.findUnique({ where: { id: other.id } })).not.toBeNull();
    expect(await prisma.message.findUnique({ where: { id: message.id } })).not.toBeNull();
    expect(await prisma.report.findUnique({ where: { id: report.id } })).not.toBeNull();
  });
});

describe('referential integrity', () => {
  it('cascades a hard user delete through swipes and matches', async () => {
    const a = await createUser();
    const b = await createUser();
    await createSwipe(a.id, b.id, Mode.dating);
    await createMatch(a.id, b.id, Mode.dating);

    await prisma.user.delete({ where: { id: a.id } });

    expect(await prisma.swipe.count()).toBe(0);
    expect(await prisma.match.count()).toBe(0);
    // The other user is untouched.
    expect(await prisma.user.findUnique({ where: { id: b.id } })).not.toBeNull();
  });

  it('cascades a conversation delete through its messages', async () => {
    const a = await createUser();
    const b = await createUser();
    const match = await createMatch(a.id, b.id, Mode.dating);
    const conversation = await createConversation(match.id, Mode.dating);
    await createMessage(conversation.id, a.id);

    await prisma.conversation.delete({ where: { id: conversation.id } });

    expect(await prisma.message.count()).toBe(0);
  });
});

describe('data formats (spec §4.6)', () => {
  it('stores enums as strings, never integers', async () => {
    const a = await createUser();
    const b = await createUser();
    await createSwipe(a.id, b.id, Mode.pet_dates, 'super_like');

    const rows = await prisma.$queryRaw<{ mode: string; action: string }[]>`
      SELECT mode::text AS mode, action::text AS action FROM swipes
    `;

    expect(rows[0]).toEqual({ mode: 'pet_dates', action: 'super_like' });
  });

  it('stores money as integer minor units', async () => {
    const product = await prisma.subscriptionProduct.create({
      data: { slug: 'test_monthly', name: 'Test', tier: 'basic', billing_cycle: 'monthly' },
    });

    const price = await prisma.priceVersion.create({
      data: {
        product_id: product.id,
        amount_minor: 1900,
        currency: 'USD',
        effective_from: new Date(),
      },
    });

    expect(price.amount_minor).toBe(1900);
    expect(Number.isInteger(price.amount_minor)).toBe(true);

    await expect(
      prisma.priceVersion.create({
        data: {
          product_id: product.id,
          amount_minor: -100,
          currency: 'USD',
          effective_from: new Date(),
        },
      }),
    ).rejects.toThrow(/price_versions_amount_check|constraint/i);
  });

  it('stores timestamps that serialise to UTC ISO-8601 with Z', async () => {
    const user = await createUser();
    expect(user.created_at.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

describe('entitlement matrix is data, not code (spec §5.11)', () => {
  it('resolves a tier to flags by reading rows', async () => {
    const flag = await prisma.entitlementFlag.create({
      data: {
        key: 'test_flag',
        label: 'Test flag',
        value_type: 'number',
      },
    });

    await prisma.tierEntitlement.createMany({
      data: [
        { tier: 'free', flag_id: flag.id, value: 50 },
        { tier: 'advanced', flag_id: flag.id, value: -1 },
      ],
    });

    const free = await prisma.tierEntitlement.findUniqueOrThrow({
      where: { tier_flag_id: { tier: 'free', flag_id: flag.id } },
    });
    const advanced = await prisma.tierEntitlement.findUniqueOrThrow({
      where: { tier_flag_id: { tier: 'advanced', flag_id: flag.id } },
    });

    expect(free.value).toBe(50);
    expect(advanced.value).toBe(-1);
  });

  it('refuses two rows for the same tier and flag', async () => {
    const flag = await prisma.entitlementFlag.create({
      data: { key: 'dupe_flag', label: 'Dupe', value_type: 'boolean' },
    });
    await prisma.tierEntitlement.create({ data: { tier: 'free', flag_id: flag.id, value: true } });

    await expect(
      prisma.tierEntitlement.create({ data: { tier: 'free', flag_id: flag.id, value: false } }),
    ).rejects.toThrow(/unique|constraint/i);
  });
});

describe('store notifications are idempotent (spec §5.10)', () => {
  it('refuses a duplicate notification id from the same store', async () => {
    await prisma.storeNotification.create({
      data: { source: 'apple', notification_id: 'apple-notif-1', payload: { type: 'DID_RENEW' } },
    });

    await expect(
      prisma.storeNotification.create({
        data: { source: 'apple', notification_id: 'apple-notif-1', payload: { type: 'DID_RENEW' } },
      }),
    ).rejects.toThrow(/unique|constraint/i);

    // The same id from the other store is a different notification.
    const google = await prisma.storeNotification.create({
      data: { source: 'google', notification_id: 'apple-notif-1', payload: {} },
    });
    expect(google.id).toBeDefined();
  });
});
