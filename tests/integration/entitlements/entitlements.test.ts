import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import * as entitlementsService from '@modules/entitlements/entitlements.service';
import {
  ALL_ENTITLEMENT_KEYS,
  ENTITLEMENT_KEYS,
  FLAG_VALUE_TYPES,
} from '@modules/entitlements/entitlements.types';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import {
  connectRedis,
  disconnectRedis,
  seedEntitlements,
  setFlag,
  setTier,
} from '../../helpers/entitlements';

/**
 * Entitlement resolution (spec 5.11, Batch 6).
 *
 * The rule under test throughout: the matrix is DATA. Every assertion here
 * changes behaviour by editing a seeded row, never by editing code — because
 * open decisions #2, #3, #7 and #10 must be answerable after launch.
 */

const ENTITLEMENTS = `${API_PREFIX}/me/entitlements`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});
afterAll(async () => {
  await closeDatabase();
  // The endpoint reads quota counters, so this suite holds a real Redis
  // connection. Left open, it keeps the jest worker alive past the last test.
  await disconnectRedis();
});

describe('GET /me/entitlements', () => {
  it('returns every declared flag, so the app never has to guess', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(ENTITLEMENTS).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(Object.keys(response.body.data.flags).sort()).toEqual([...ALL_ENTITLEMENT_KEYS].sort());
  });

  it('gives each flag the value type the vocabulary declares', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(ENTITLEMENTS).set(authHeader(tokens));

    for (const key of ALL_ENTITLEMENT_KEYS) {
      expect(typeof response.body.data.flags[key]).toBe(FLAG_VALUE_TYPES[key]);
    }
  });

  it('defaults a new account to free', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(ENTITLEMENTS).set(authHeader(tokens));

    expect(response.body.data.tier).toBe('free');
    expect(response.body.data.upgrade_available).toBe(true);
  });

  it('stops advertising an upgrade on the top tier', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await setTier(user_id, 'advanced');

    const response = await api.get(ENTITLEMENTS).set(authHeader(tokens));

    expect(response.body.data.tier).toBe('advanced');
    expect(response.body.data.upgrade_available).toBe(false);
  });

  it('carries every quota with what is left of it', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(ENTITLEMENTS).set(authHeader(tokens));

    const swipes = response.body.data.quotas.swipes;
    expect(swipes.limit).toBe(50);
    expect(swipes.used).toBe(0);
    expect(swipes.remaining).toBe(50);
    expect(swipes.is_unlimited).toBe(false);
    // spec 4.6: UTC, ISO-8601, Z, and the key ends in _at.
    expect(swipes.resets_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('reports -1 rather than a number for an unlimited tier', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await setTier(user_id, 'advanced');

    const response = await api.get(ENTITLEMENTS).set(authHeader(tokens));

    expect(response.body.data.quotas.swipes.limit).toBe(-1);
    expect(response.body.data.quotas.swipes.is_unlimited).toBe(true);
    expect(response.body.data.quotas.messages.is_unlimited).toBe(true);
  });

  it('requires a token', async () => {
    const response = await api.get(ENTITLEMENTS);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('the matrix is data, not code', () => {
  it('changes a plan when a seeded row changes, with no deploy', async () => {
    const { tokens } = await createAuthenticatedUser();

    const before = await api.get(ENTITLEMENTS).set(authHeader(tokens));
    expect(before.body.data.flags.rewind).toBe(false);

    // This is open decision #10 being answered — a row edit, nothing more.
    await setFlag('free', ENTITLEMENT_KEYS.REWIND, true);

    const after = await api.get(ENTITLEMENTS).set(authHeader(tokens));
    expect(after.body.data.flags.rewind).toBe(true);
  });

  it('seeds a complete matrix for all three tiers', async () => {
    for (const tier of ['free', 'basic', 'advanced'] as const) {
      const rows = await prisma.tierEntitlement.count({ where: { tier } });
      expect(rows).toBe(ALL_ENTITLEMENT_KEYS.length);
    }
  });
});

describe('resolver failure modes', () => {
  it('fails CLOSED when a flag is missing, rather than handing out premium', async () => {
    const { user_id } = await createAuthenticatedUser();

    // Simulates a broken seed: the row for a paid feature has vanished.
    const flag = await prisma.entitlementFlag.findUniqueOrThrow({
      where: { key: ENTITLEMENT_KEYS.SEE_WHO_LIKED_YOU },
    });
    await prisma.tierEntitlement.deleteMany({ where: { flag_id: flag.id } });
    entitlementsService.clearEntitlementCache();

    await setTier(user_id, 'advanced');

    // Advanced normally has this. A missing row must not resolve to "allowed".
    expect(await entitlementsService.hasFeature(user_id, ENTITLEMENT_KEYS.SEE_WHO_LIKED_YOU)).toBe(
      false,
    );
  });

  it('fails closed when a stored value has the wrong type', async () => {
    const { user_id } = await createAuthenticatedUser();

    const flag = await prisma.entitlementFlag.findUniqueOrThrow({
      where: { key: ENTITLEMENT_KEYS.BOOST },
    });
    // A number where a boolean belongs would be quietly truthy without the
    // type check in the resolver.
    await prisma.tierEntitlement.updateMany({ where: { flag_id: flag.id }, data: { value: 1 } });
    entitlementsService.clearEntitlementCache();

    await setTier(user_id, 'advanced');

    expect(await entitlementsService.hasFeature(user_id, ENTITLEMENT_KEYS.BOOST)).toBe(false);
  });

  it('404s for a user that does not exist', async () => {
    await expect(
      entitlementsService.resolve('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('requireFeature', () => {
  it('throws PREMIUM_REQUIRED with the context a paywall needs', async () => {
    const { user_id } = await createAuthenticatedUser();

    await expect(
      entitlementsService.requireFeature(user_id, ENTITLEMENT_KEYS.BOOST),
    ).rejects.toMatchObject({
      code: 'PREMIUM_REQUIRED',
      statusCode: 403,
      details: {
        required_feature: ENTITLEMENT_KEYS.BOOST,
        current_tier: 'free',
        upgrade_available: true,
      },
    });
  });

  it('passes silently when the tier includes the feature', async () => {
    const { user_id } = await createAuthenticatedUser();
    await setTier(user_id, 'advanced');

    await expect(
      entitlementsService.requireFeature(user_id, ENTITLEMENT_KEYS.BOOST),
    ).resolves.toBeUndefined();
  });
});

describe('the mode cap reads the same matrix', () => {
  it('reflects a seeded change without touching mode code', async () => {
    const { tokens } = await createAuthenticatedUser();

    await setFlag('free', ENTITLEMENT_KEYS.MAX_SIMULTANEOUS_MODES, 7);

    const response = await api.get(`${API_PREFIX}/modes`).set(authHeader(tokens));

    expect(response.body.data.max_simultaneous_modes).toBe(7);
  });
});
