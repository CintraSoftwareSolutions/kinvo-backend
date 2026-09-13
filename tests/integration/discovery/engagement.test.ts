import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { DISCOVERY } from '@config/constants';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { CAMDEN, LONDON, createBlock, createSwipe } from '../../helpers/factories';
import { createDiscoverableUser, createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import {
  connectRedis,
  disconnectRedis,
  seedEntitlements,
  setTier,
} from '../../helpers/entitlements';

/**
 * Likes-you, boost, and deck stats (spec §5.3, §7, Batch 7).
 *
 * Decision #5: the Requests tab is a likes-you inbox of PROFILES, not messages.
 * Users cannot message before matching, so a conversation always has a match
 * behind it.
 */

const LIKES_YOU = (mode: string) => `${API_PREFIX}/discovery/${mode}/likes-you`;
const BOOST = (mode: string) => `${API_PREFIX}/discovery/${mode}/boost`;
const STATS = (mode: string) => `${API_PREFIX}/discovery/${mode}/stats`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('GET /discovery/:mode/likes-you', () => {
  it('is premium', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PREMIUM_REQUIRED');
  });

  it('lists people who liked the viewer in this mode', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    const admirer = await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      display_name: 'Admirer',
    });
    await createSwipe(admirer.user.id, viewer.user_id, Mode.dating, 'like');

    const response = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].user.display_name).toBe('Admirer');
    expect(response.body.data[0].is_super_like).toBe(false);
  });

  it('flags a super like', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    const admirer = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    await createSwipe(admirer.user.id, viewer.user_id, Mode.dating, 'super_like');

    const response = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data[0].is_super_like).toBe(true);
  });

  it('ignores a pass', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    const other = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    await createSwipe(other.user.id, viewer.user_id, Mode.dating, 'pass');

    const response = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('is scoped to the mode', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      also_modes: [Mode.fitness],
    });
    await setTier(viewer.user_id, 'advanced');

    const admirer = await createDiscoverableUser({ mode: Mode.fitness, coordinates: CAMDEN });
    await createSwipe(admirer.user.id, viewer.user_id, Mode.fitness, 'like');

    const dating = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));
    const fitness = await api.get(LIKES_YOU('fitness')).set(authHeader(viewer.tokens));

    expect(dating.body.data).toEqual([]);
    expect(fitness.body.data).toHaveLength(1);
  });

  it('drops someone the viewer has already answered', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    const admirer = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    await createSwipe(admirer.user.id, viewer.user_id, Mode.dating, 'like');
    await createSwipe(viewer.user_id, admirer.user.id, Mode.dating, 'pass');

    const response = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));

    // Already answered — matched or passed — so no longer a pending request.
    expect(response.body.data).toEqual([]);
  });

  it('hides a like from someone who then blocked the viewer', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    const admirer = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    await createSwipe(admirer.user.id, viewer.user_id, Mode.dating, 'like');
    await createBlock(admirer.user.id, viewer.user_id);

    const response = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));

    // Blocks beat everything, including a like that arrived before the block.
    expect(response.body.data).toEqual([]);
  });

  it('hides a like from a suspended account', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    const admirer = await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      status: 'suspended',
    });
    await createSwipe(admirer.user.id, viewer.user_id, Mode.dating, 'like');

    const response = await api.get(LIKES_YOU('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('paginates newest first without repeating anyone', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    for (let i = 0; i < 4; i += 1) {
      const admirer = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
      await createSwipe(admirer.user.id, viewer.user_id, Mode.dating, 'like');
    }

    const first = await api.get(`${LIKES_YOU('dating')}?limit=2`).set(authHeader(viewer.tokens));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.pagination.has_more).toBe(true);

    const second = await api
      .get(`${LIKES_YOU('dating')}?limit=2&cursor=${first.body.meta.pagination.next_cursor}`)
      .set(authHeader(viewer.tokens));

    const firstIds = first.body.data.map((l: { swipe_id: string }) => l.swipe_id);
    const secondIds = second.body.data.map((l: { swipe_id: string }) => l.swipe_id);

    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });
});

describe('POST /discovery/:mode/boost', () => {
  it('is premium', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.post(BOOST('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PREMIUM_REQUIRED');
  });

  it('starts a boost that ends in the future', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    const response = await api.post(BOOST('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(201);
    expect(response.body.data.is_active).toBe(true);
    expect(new Date(response.body.data.ends_at).getTime()).toBeGreaterThan(Date.now());
    expect(response.body.data.ends_at).toMatch(/Z$/);
  });

  it('refuses to stack a second boost', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    await api.post(BOOST('dating')).set(authHeader(viewer.tokens));
    const response = await api.post(BOOST('dating')).set(authHeader(viewer.tokens));

    // Stacking would let one tap buy two windows.
    expect(response.status).toBe(409);
    expectErrorEnvelope(response.body, 'CONFLICT');
  });

  it('is scoped to one mode', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      also_modes: [Mode.fitness],
    });
    await setTier(viewer.user_id, 'advanced');

    await api.post(BOOST('dating')).set(authHeader(viewer.tokens));
    const response = await api.post(BOOST('fitness')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(201);
  });

  it('lifts ranking but cannot bypass a filter', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      radius_metres: 10_000,
    });

    const near = await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      display_name: 'Near',
    });
    const boostedButBlocked = await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      display_name: 'Blocked',
    });

    await prisma.boost.create({
      data: {
        user_id: boostedButBlocked.user.id,
        mode: Mode.dating,
        ends_at: new Date(Date.now() + DISCOVERY.BOOST_DURATION_MINUTES * 60 * 1000),
      },
    });
    await createBlock(viewer.user_id, boostedButBlocked.user.id);

    const response = await api
      .get(`${API_PREFIX}/discovery/dating/deck`)
      .set(authHeader(viewer.tokens));

    // A boost is a ranking input. It must never place someone into a deck a
    // filter excluded them from — that is how a boost would beat a block.
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].user.id).toBe(near.user.id);
  });
});

describe('GET /discovery/:mode/stats', () => {
  it('returns the whole empty state in one call', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    const response = await api.get(STATS('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toMatchObject({
      mode: 'dating',
      liked: 1,
      passed: 0,
      super_liked: 0,
      matches: 0,
    });
    expect(response.body.data.boost).toBeNull();
    expect(response.body.data.swipe_quota.remaining).toBe(49);
  });

  it('counts likes received without revealing who they are', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const admirer = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    await createSwipe(admirer.user.id, viewer.user_id, Mode.dating, 'like');

    const response = await api.get(STATS('dating')).set(authHeader(viewer.tokens));

    // A free user sees the count so the paywall has something to sell, but the
    // profiles stay behind it.
    expect(response.body.data.likes_received).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain(admirer.user.id);
  });

  it('is scoped to the mode', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      also_modes: [Mode.fitness],
    });
    const target = await createDiscoverableUser({
      mode: Mode.dating,
      coordinates: CAMDEN,
      also_modes: [Mode.fitness],
    });

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    const dating = await api.get(STATS('dating')).set(authHeader(viewer.tokens));
    const fitness = await api.get(STATS('fitness')).set(authHeader(viewer.tokens));

    expect(dating.body.data.liked).toBe(1);
    expect(fitness.body.data.liked).toBe(0);
  });

  it('reports a running boost', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');

    await api.post(BOOST('dating')).set(authHeader(viewer.tokens));

    const response = await api.get(STATS('dating')).set(authHeader(viewer.tokens));

    expect(response.body.data.boost).not.toBeNull();
    expect(response.body.data.boost.is_active).toBe(true);
  });

  it('requires a token', async () => {
    const response = await api.get(STATS('dating'));

    expect(response.status).toBe(401);
  });
});
