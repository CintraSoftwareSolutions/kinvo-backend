import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { generateDeck, scoreCandidate } from '@modules/discovery/deck.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { CAMDEN, LONDON, MANCHESTER, createBlock } from '../../helpers/factories';
import { createDiscoverableUser, createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';

/**
 * Deck generation (spec §5.3, Batch 7).
 *
 * The deck is where six rules have to hold simultaneously — blocks, mode
 * scoping, radius, age, already-swiped, and account state. Any one of them
 * failing surfaces a person who should never have been shown, so each gets its
 * own case rather than a single composite assertion.
 */

const DECK = (mode: string) => `${API_PREFIX}/discovery/${mode}/deck`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('GET /discovery/:mode/deck', () => {
  it('returns nearby candidates who have the mode enabled', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      display_name: 'Nearby',
    });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].user.display_name).toBe('Nearby');
  });

  it('returns distance in metres, not miles (spec §4.6)', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    // Westminster to Camden is roughly 3.7 km. Miles would be ~2.3.
    expect(response.body.data[0].distance_metres).toBeGreaterThan(3000);
    expect(response.body.data[0].distance_metres).toBeLessThan(5000);
  });

  it('returns an empty array, never null, when nobody is nearby', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta.pagination.has_more).toBe(false);
    expect(response.body.meta.pagination.next_cursor).toBeNull();
  });

  it('carries enough to render a card without a follow-up call (spec §4.7)', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    const card = response.body.data[0];
    expect(Object.keys(card.user).sort()).toEqual([
      'age',
      'display_name',
      'id',
      'is_online',
      'is_premium',
      'is_verified',
      'last_active_at',
      'primary_photo_url',
    ]);
    expect(card).toHaveProperty('bio');
    expect(card).toHaveProperty('interests');
  });

  it('requires a token', async () => {
    const response = await api.get(DECK('dating'));

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });

  it('rejects a mode that does not exist', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(DECK('telepathy')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('refuses a mode the viewer has not switched on', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(DECK('fitness')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'BAD_REQUEST');
  });
});

describe('deck exclusions (spec §5.5)', () => {
  it('never shows someone who blocked the viewer', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const blocker = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await createBlock(blocker.user.id, viewer.user_id);

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('never shows someone the viewer blocked', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const blocked = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await createBlock(viewer.user_id, blocked.user.id);

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('never shows the viewer themselves', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data.map((c: { user: { id: string } }) => c.user.id)).not.toContain(
      viewer.user_id,
    );
  });

  it('excludes snoozed accounts (spec §5.6)', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, is_snoozed: true });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('excludes suspended accounts', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, status: 'suspended' });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('excludes accounts that have not finished onboarding', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, onboarded: false });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    // An account created by social sign-in has no date of birth until
    // onboarding runs the 18+ check. It must never reach a deck.
    expect(response.body.data).toEqual([]);
  });

  it('excludes people already swiped IN THIS MODE', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });
});

describe('mode scoping', () => {
  it('does not show someone who enabled a different mode', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({ mode: Mode.fitness, coordinates: CAMDEN });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('keeps a pass in one mode out of another mode’s exclusions', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      also_modes: [Mode.study_buddy],
    });
    const target = await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      also_modes: [Mode.study_buddy],
    });

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    const dating = await api.get(DECK('dating')).set(authHeader(viewer.tokens));
    const study = await api.get(DECK('study_buddy')).set(authHeader(viewer.tokens));

    // Eight parallel graphs, not one graph with a mode tag.
    expect(dating.body.data).toEqual([]);
    expect(study.body.data).toHaveLength(1);
  });
});

describe('filters', () => {
  it('excludes people outside the radius', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      radius_metres: 10_000,
    });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN }); // ~3.7 km
    await createDiscoverableUser({ mode: Mode.dating, coordinates: MANCHESTER }); // ~262 km

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].distance_metres).toBeLessThan(10_000);
  });

  it('includes someone the radius reaches but a smaller one would not', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      radius_metres: 300_000,
    });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: MANCHESTER });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toHaveLength(1);
  });

  it('excludes people outside the age range', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      min_age: 25,
      max_age: 30,
    });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, age: 22 });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, age: 45 });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, age: 27 });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].user.age).toBe(27);
  });

  it('keeps someone at exactly the maximum age', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      min_age: 25,
      max_age: 30,
    });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, age: 30 });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    // Someone whose 30th birthday was today is 30 and still inside "up to 30".
    expect(response.body.data).toHaveLength(1);
  });

  it('applies verified_only as a hard filter', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      verified_only: true,
    });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN, is_verified: false });
    const verified = await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      is_verified: true,
    });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].user.id).toBe(verified.user.id);
  });
});

describe('ranking', () => {
  it('ranks verified users higher without filtering anyone out', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      is_verified: false,
      display_name: 'Unverified',
    });
    await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      is_verified: true,
      display_name: 'Verified',
    });

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    // Both present — verified is a ranking input, not a hard filter (spec §5.3).
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0].user.display_name).toBe('Verified');
  });

  it('scores a boost above a verified badge but never past a filter', () => {
    const base = {
      lastActiveAt: new Date(),
      distanceMetres: 1000,
      radiusMetres: 50_000,
      now: new Date(),
    };

    const verified = scoreCandidate({ ...base, isVerified: true, isBoosted: false });
    const boosted = scoreCandidate({ ...base, isVerified: false, isBoosted: true });

    expect(boosted).toBeGreaterThan(verified);
  });

  it('scores a recently active user above a dormant one', () => {
    const base = {
      isVerified: false,
      isBoosted: false,
      distanceMetres: 1000,
      radiusMetres: 50_000,
      now: new Date('2026-08-26T12:00:00Z'),
    };

    const fresh = scoreCandidate({ ...base, lastActiveAt: new Date('2026-08-26T11:00:00Z') });
    const stale = scoreCandidate({ ...base, lastActiveAt: new Date('2026-08-01T11:00:00Z') });

    expect(fresh).toBeGreaterThan(stale);
  });

  it('scores a nearer user above a distant one', () => {
    const base = {
      isVerified: false,
      isBoosted: false,
      lastActiveAt: new Date(),
      radiusMetres: 50_000,
      now: new Date(),
    };

    expect(scoreCandidate({ ...base, distanceMetres: 500 })).toBeGreaterThan(
      scoreCandidate({ ...base, distanceMetres: 40_000 }),
    );
  });
});

describe('deck persistence', () => {
  it('is stable across calls, so a card cannot jump between pages', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    for (let i = 0; i < 5; i += 1) {
      await createDiscoverableUser({
        mode: Mode.dating,
        coordinates: CAMDEN,
        display_name: `Card ${i}`,
      });
    }

    const first = await api.get(DECK('dating')).set(authHeader(viewer.tokens));
    const second = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(second.body.data.map((c: { entry_id: string }) => c.entry_id)).toEqual(
      first.body.data.map((c: { entry_id: string }) => c.entry_id),
    );
  });

  it('paginates by cursor without repeating a card', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    for (let i = 0; i < 5; i += 1) {
      await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    }

    const first = await api.get(`${DECK('dating')}?limit=2`).set(authHeader(viewer.tokens));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.pagination.has_more).toBe(true);

    const second = await api
      .get(`${DECK('dating')}?limit=2&cursor=${first.body.meta.pagination.next_cursor}`)
      .set(authHeader(viewer.tokens));

    const firstIds = first.body.data.map((c: { entry_id: string }) => c.entry_id);
    const secondIds = second.body.data.map((c: { entry_id: string }) => c.entry_id);

    expect(secondIds).toHaveLength(2);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });

  it('rejects a mangled cursor as a client error, not a 500', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .get(`${DECK('dating')}?cursor=not-a-real-cursor`)
      .set(authHeader(viewer.tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('regenerating does not resurrect a card already swiped', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api.get(DECK('dating')).set(authHeader(viewer.tokens));
    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    await generateDeck(viewer.user_id, Mode.dating);

    const response = await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('keys the deck to the UTC day', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api.get(DECK('dating')).set(authHeader(viewer.tokens));

    const deck = await prisma.deck.findFirst({ where: { user_id: viewer.user_id } });

    expect(deck).not.toBeNull();
    expect(deck?.deck_date.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });
});
