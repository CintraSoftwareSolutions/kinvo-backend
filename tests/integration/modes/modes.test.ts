import { API_PREFIX } from '@config/constants';
import { Mode, VerificationStatus, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { setTier } from '../../helpers/entitlements';

/**
 * The eight modes (spec §1, §5.2).
 *
 * The rule under test throughout: preferences are stored PER MODE, not once per
 * user. Everything else here — the entitlement cap, the Cuddle gate, the single
 * primary — exists to protect that.
 */

const MODES = `${API_PREFIX}/modes`;

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});
afterAll(closeDatabase);

/** The tier→flag matrix is data, so tests must seed it like production does. */
async function seedEntitlements(maxModes = 3) {
  const flag = await prisma.entitlementFlag.create({
    data: { key: 'max_simultaneous_modes', label: 'Simultaneous modes', value_type: 'number' },
  });

  await prisma.tierEntitlement.createMany({
    data: [
      { tier: 'free', flag_id: flag.id, value: maxModes },
      { tier: 'basic', flag_id: flag.id, value: 5 },
      { tier: 'advanced', flag_id: flag.id, value: -1 },
    ],
  });
}

async function verify(userId: string) {
  await prisma.verification.create({
    data: { user_id: userId, method: 'photo', status: VerificationStatus.approved },
  });
  await prisma.user.update({ where: { id: userId }, data: { is_verified: true } });
}

describe('GET /modes', () => {
  it('returns all eight, enabled or not', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(MODES).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.modes).toHaveLength(8);
    expect(response.body.data.modes.map((m: { mode: string }) => m.mode).sort()).toEqual([
      'cuddle',
      'dating',
      'fitness',
      'foodie',
      'networking',
      'pet_dates',
      'study_buddy',
      'trading',
    ]);
  });

  it('carries the label the app renders for each deck action (spec §1)', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(MODES).set(authHeader(tokens));
    const byMode = Object.fromEntries(
      response.body.data.modes.map((m: { mode: string }) => [m.mode, m]),
    );

    // The API only ever accepts pass | like | super_like. These strings exist
    // so adding a mode never needs an app release.
    expect(byMode.study_buddy.primary_action_label).toBe('Study');
    expect(byMode.trading.primary_action_label).toBe('Trade');
    expect(byMode.dating.primary_action_label).toBe('Like');
  });

  it('reports the cap from the seeded matrix, not a hardcoded number', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(MODES).set(authHeader(tokens));

    expect(response.body.data.max_simultaneous_modes).toBe(3);
    expect(response.body.data.enabled_count).toBe(0);
  });

  it('returns radius in metres (spec §4.6)', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(MODES).set(authHeader(tokens));

    // A miles-based default would be a two-digit number.
    expect(response.body.data.modes[0].radius_metres).toBeGreaterThan(1000);
  });

  it('requires authentication', async () => {
    const response = await api.get(MODES);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('per-mode preferences (spec §5.2)', () => {
  it('keeps preferences independent between modes', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    await api.patch(`${MODES}/cuddle`).set(auth).send({ radius_metres: 5000, is_enabled: false });
    await api
      .patch(`${MODES}/networking`)
      .set(auth)
      .send({ radius_metres: 80000, is_enabled: false });

    const response = await api.get(MODES).set(auth);
    const byMode = Object.fromEntries(
      response.body.data.modes.map((m: { mode: string }) => [m.mode, m]),
    );

    // This is the whole reason UserMode exists rather than columns on Profile.
    expect(byMode.cuddle.radius_metres).toBe(5000);
    expect(byMode.networking.radius_metres).toBe(80000);
    expect(byMode.dating.radius_metres).toBe(48280);
  });

  it('keeps age ranges independent between modes', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    await api.patch(`${MODES}/dating`).set(auth).send({ min_age: 25, max_age: 35 });
    await api.patch(`${MODES}/fitness`).set(auth).send({ min_age: 18, max_age: 99 });

    const dating = await api.get(`${MODES}/dating`).set(auth);
    const fitness = await api.get(`${MODES}/fitness`).set(auth);

    expect(dating.body.data.min_age).toBe(25);
    expect(fitness.body.data.min_age).toBe(18);
  });

  it('accepts the extras that belong to a mode', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/study_buddy`)
      .set(authHeader(tokens))
      .send({ preferences: { subject: 'Medicine', academic_level: 'undergraduate' } });

    expect(response.status).toBe(200);
    expect(response.body.data.preferences).toEqual({
      subject: 'Medicine',
      academic_level: 'undergraduate',
    });
  });

  it('rejects an extra that belongs to a different mode', async () => {
    const { tokens } = await createAuthenticatedUser();

    // pet_type is a pet_dates field. Storing it on dating would be silently
    // useless — a filter that quietly matches nobody.
    const response = await api
      .patch(`${MODES}/dating`)
      .set(authHeader(tokens))
      .send({ preferences: { pet_type: 'dog' } });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(Object.keys(response.body.error.details).join()).toContain('preferences');
  });

  it('rejects an invalid value within a mode-specific field', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/pet_dates`)
      .set(authHeader(tokens))
      .send({ preferences: { pet_type: 'dinosaur' } });

    expect(response.status).toBe(400);
  });

  it('stores trading instruments as interest tags and nothing more (spec §1)', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/trading`)
      .set(authHeader(tokens))
      .send({ preferences: { instruments: ['equities', 'crypto'], experience_level: 'hobbyist' } });

    expect(response.status).toBe(200);
    expect(response.body.data.preferences.instruments).toEqual(['equities', 'crypto']);
  });

  it('refuses an inverted age range', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/dating`)
      .set(authHeader(tokens))
      .send({ min_age: 40, max_age: 30 });

    expect(response.status).toBe(400);
  });

  it('refuses a minimum age below 18', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/dating`)
      .set(authHeader(tokens))
      .send({ min_age: 16 });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('min_age');
  });

  it('rejects a mode that does not exist', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/speed_dating`)
      .set(authHeader(tokens))
      .send({ is_enabled: true });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('mode');
  });
});

describe('the entitlement cap', () => {
  it('allows up to the free-tier limit', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    for (const mode of ['dating', 'foodie', 'fitness']) {
      const response = await api.patch(`${MODES}/${mode}`).set(auth).send({ is_enabled: true });
      expect(response.status).toBe(200);
    }

    const list = await api.get(MODES).set(auth);
    expect(list.body.data.enabled_count).toBe(3);
  });

  it('returns PREMIUM_REQUIRED with paywall context beyond the limit', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    for (const mode of ['dating', 'foodie', 'fitness']) {
      await api.patch(`${MODES}/${mode}`).set(auth).send({ is_enabled: true });
    }

    const response = await api.patch(`${MODES}/networking`).set(auth).send({ is_enabled: true });

    // spec §4.9: a limit that sells subscriptions carries upgrade context.
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PREMIUM_REQUIRED');
    expect(response.body.error.details).toMatchObject({ limit: 3, upgrade_available: true });
  });

  it('lets an at-limit user still edit an already-enabled mode', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    for (const mode of ['dating', 'foodie', 'fitness']) {
      await api.patch(`${MODES}/${mode}`).set(auth).send({ is_enabled: true });
    }

    // Re-saving preferences is not a new enable and must not hit the paywall.
    const response = await api
      .patch(`${MODES}/dating`)
      .set(auth)
      .send({ is_enabled: true, radius_metres: 20000 });

    expect(response.status).toBe(200);
  });

  it('frees a slot when a mode is disabled', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    for (const mode of ['dating', 'foodie', 'fitness']) {
      await api.patch(`${MODES}/${mode}`).set(auth).send({ is_enabled: true });
    }

    await api.patch(`${MODES}/foodie`).set(auth).send({ is_enabled: false });

    const response = await api.patch(`${MODES}/networking`).set(auth).send({ is_enabled: true });
    expect(response.status).toBe(200);
  });

  it('treats -1 as unlimited', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    // Through the helper, which creates a real subscription. Writing
    // `subscription_tier` directly stopped granting anything in Batch 13 —
    // entitlement resolves from Subscription rows now, because a column
    // somebody can edit is not an entitlement.
    await setTier(userId, 'advanced');
    await verify(userId);

    const auth = authHeader(tokens);
    for (const mode of Object.values(Mode)) {
      const response = await api.patch(`${MODES}/${mode}`).set(auth).send({ is_enabled: true });
      expect(response.status).toBe(200);
    }

    const list = await api.get(MODES).set(auth);
    expect(list.body.data.enabled_count).toBe(8);
  });
});

describe('Cuddle requires verification (spec §5.7)', () => {
  it('refuses to enable it for an unverified user', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/cuddle`)
      .set(authHeader(tokens))
      .send({ is_enabled: true });

    // Cuddle invites physical-contact meetups and will attract misuse, so it
    // is the one mode gated on identity.
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'FORBIDDEN');
    expect(response.body.error.details).toMatchObject({ reason: 'verification_required' });
  });

  it('allows it once verified', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    await verify(userId);

    const response = await api
      .patch(`${MODES}/cuddle`)
      .set(authHeader(tokens))
      .send({ is_enabled: true });

    expect(response.status).toBe(200);
    expect(response.body.data.is_enabled).toBe(true);
  });

  it('tells the app in advance so it can grey the toggle out', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(MODES).set(authHeader(tokens));
    const byMode = Object.fromEntries(
      response.body.data.modes.map((m: { mode: string }) => [m.mode, m]),
    );

    // Better than letting the user tap it and receive a 403 they did not expect.
    expect(byMode.cuddle.requires_verification).toBe(true);
    expect(byMode.cuddle.can_enable).toBe(false);
    expect(byMode.dating.requires_verification).toBe(false);
    expect(byMode.dating.can_enable).toBe(true);
  });

  it('does not gate configuring it while disabled', async () => {
    const { tokens } = await createAuthenticatedUser();

    // Setting preferences before verifying is harmless; only enabling is gated.
    const response = await api
      .patch(`${MODES}/cuddle`)
      .set(authHeader(tokens))
      .send({ radius_metres: 5000 });

    expect(response.status).toBe(200);
  });
});

describe('the primary mode', () => {
  it('makes the first enabled mode primary automatically', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${MODES}/foodie`)
      .set(authHeader(tokens))
      .send({ is_enabled: true });

    expect(response.body.data.is_primary).toBe(true);
  });

  it('keeps exactly one primary when changed', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    await api.patch(`${MODES}/dating`).set(auth).send({ is_enabled: true });
    await api.patch(`${MODES}/fitness`).set(auth).send({ is_enabled: true });

    const response = await api.post(`${MODES}/fitness/primary`).set(auth);

    expect(response.status).toBe(200);
    const primaries = response.body.data.modes.filter((m: { is_primary: boolean }) => m.is_primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].mode).toBe('fitness');
  });

  it('refuses to make a disabled mode primary', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);
    await api.patch(`${MODES}/dating`).set(auth).send({ is_enabled: true });

    const response = await api.post(`${MODES}/trading/primary`).set(auth);

    expect(response.status).toBe(400);
  });

  it('moves the flag elsewhere when the primary is disabled', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    await api.patch(`${MODES}/dating`).set(auth).send({ is_enabled: true });
    await api.patch(`${MODES}/fitness`).set(auth).send({ is_enabled: true });

    // Disabling the primary must not leave the account with none at all.
    await api.patch(`${MODES}/dating`).set(auth).send({ is_enabled: false });

    const response = await api.get(MODES).set(auth);
    expect(response.body.data.primary_mode).toBe('fitness');
  });

  it('leaves no primary when the last mode is disabled', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    await api.patch(`${MODES}/dating`).set(auth).send({ is_enabled: true });
    await api.patch(`${MODES}/dating`).set(auth).send({ is_enabled: false });

    const response = await api.get(MODES).set(auth);
    expect(response.body.data.primary_mode).toBeNull();
    expect(response.body.data.enabled_count).toBe(0);
  });
});

describe('isolation between users', () => {
  it("never lets one user's modes affect another's", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();

    await api
      .patch(`${MODES}/dating`)
      .set(authHeader(alice.tokens))
      .send({ is_enabled: true, radius_metres: 1000 });

    const bobModes = await api.get(MODES).set(authHeader(bob.tokens));

    expect(bobModes.body.data.enabled_count).toBe(0);
    const bobDating = bobModes.body.data.modes.find((m: { mode: string }) => m.mode === 'dating');
    expect(bobDating.radius_metres).toBe(48280);
  });
});
