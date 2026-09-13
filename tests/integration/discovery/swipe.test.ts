import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';
import { resetQuotas } from '@modules/entitlements/quota.service';
import type { AuthTokens } from '@modules/auth/auth.types';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { CAMDEN, LONDON, createBlock } from '../../helpers/factories';
import { createDiscoverableUser, createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import {
  connectRedis,
  disconnectRedis,
  seedEntitlements,
  setFlag,
  setTier,
} from '../../helpers/entitlements';

/**
 * Swiping, matching, and rewind (spec §5.3, Batch 7).
 *
 * The rule this suite exists to protect: a match belongs to EXACTLY ONE MODE.
 * The same two people liking each other in dating and in study_buddy produce
 * two independent matches, and a like in one mode must never complete a match
 * in another.
 */

const SWIPE = (mode: string) => `${API_PREFIX}/discovery/${mode}/swipe`;
const REWIND = (mode: string) => `${API_PREFIX}/discovery/${mode}/rewind`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

/** Both people like each other in one mode, through the API. */
async function likeEachOther(
  a: { user_id: string; tokens: AuthTokens },
  b: { user_id: string; tokens: AuthTokens },
  mode: Mode,
) {
  await api
    .post(SWIPE(mode))
    .set(authHeader(b.tokens))
    .send({ target_id: a.user_id, action: 'like' });

  return api
    .post(SWIPE(mode))
    .set(authHeader(a.tokens))
    .send({ target_id: b.user_id, action: 'like' });
}

describe('POST /discovery/:mode/swipe', () => {
  it('records a pass', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    expect(response.status).toBe(201);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.is_match).toBe(false);
    expect(response.body.data.match).toBeNull();
  });

  it('does not create a match on a one-sided like', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    expect(response.body.data.is_match).toBe(false);
    expect(await prisma.match.count()).toBe(0);
  });

  it('creates EXACTLY ONE match on a mutual like', async () => {
    const a = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const b = await createDiscoverableViewer({ mode: Mode.dating, coordinates: CAMDEN });

    const response = await likeEachOther(a, b, Mode.dating);

    expect(response.body.data.is_match).toBe(true);
    expect(response.body.data.match.mode).toBe('dating');
    // One row, not one per direction — the ordered pair is what prevents (A,B)
    // and (B,A) both existing.
    expect(await prisma.match.count()).toBe(1);
  });

  it('orders the pair so the CHECK constraint holds either way round', async () => {
    const a = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const b = await createDiscoverableViewer({ mode: Mode.dating, coordinates: CAMDEN });

    await likeEachOther(a, b, Mode.dating);

    const match = await prisma.match.findFirstOrThrow();
    expect(match.user_a_id < match.user_b_id).toBe(true);
  });

  it('marks the match when either side super liked', async () => {
    const a = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const b = await createDiscoverableViewer({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(b.tokens))
      .send({ target_id: a.user_id, action: 'super_like' });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(a.tokens))
      .send({ target_id: b.user_id, action: 'like' });

    // spec §5.3: a super_like counts as a like for matching and is surfaced to
    // the recipient.
    expect(response.body.data.match.is_super_like).toBe(true);
  });

  it('lets the same pair match independently in two modes', async () => {
    const a = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      also_modes: [Mode.study_buddy],
    });
    const b = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: CAMDEN,
      also_modes: [Mode.study_buddy],
    });

    await likeEachOther(a, b, Mode.dating);
    await likeEachOther(a, b, Mode.study_buddy);

    const matches = await prisma.match.findMany({ orderBy: { mode: 'asc' } });

    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.mode).sort()).toEqual(['dating', 'study_buddy']);
  });

  it('does not let a like in one mode complete a match in another', async () => {
    const a = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      also_modes: [Mode.study_buddy],
    });
    const b = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: CAMDEN,
      also_modes: [Mode.study_buddy],
    });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(b.tokens))
      .send({ target_id: a.user_id, action: 'like' });

    const response = await api
      .post(SWIPE('study_buddy'))
      .set(authHeader(a.tokens))
      .send({ target_id: b.user_id, action: 'like' });

    // Eight parallel graphs. A dating like is not a study-buddy like.
    expect(response.body.data.is_match).toBe(false);
    expect(await prisma.match.count()).toBe(0);
  });

  it('rejects a second swipe on the same person in the same mode', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    expect(response.status).toBe(409);
    expectErrorEnvelope(response.body, 'CONFLICT');
  });

  it('allows the same pair to be swiped once per mode', async () => {
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

    const first = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    const second = await api
      .post(SWIPE('fitness'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('rejects swiping on yourself', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: viewer.user_id, action: 'like' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('rejects an unknown action', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'nope' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('requires a token', async () => {
    const response = await api.post(SWIPE('dating')).send({ target_id: 'x', action: 'like' });

    expect(response.status).toBe(401);
  });
});

describe('swiping and blocks (spec §4.4)', () => {
  it('answers 404 — not 403 — when the target blocked the actor', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await createBlock(target.user.id, viewer.user_id);

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    // A 403 would confirm the account exists. "Blocked", "suspended",
    // "deleted" and "never existed" must be indistinguishable from outside.
    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });

  it('answers the same 404 for a user that never existed', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: '00000000-0000-4000-8000-000000000000', action: 'like' });

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });

  it('answers 404 for someone who has not enabled this mode', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.fitness, coordinates: CAMDEN });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    expect(response.status).toBe(404);
  });
});

describe('the daily swipe cap (spec §4.9)', () => {
  it('returns 422 QUOTA_EXCEEDED with paywall context, never 429', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 1);
    await resetQuotas(viewer.user_id);

    const first = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    const second = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: first.user.id, action: 'like' });

    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: second.user.id, action: 'like' });

    // 422, not 429: a rate limit protects infrastructure, a quota sells a
    // subscription. Conflating them hides the paywall.
    expect(response.status).toBe(422);
    expectErrorEnvelope(response.body, 'QUOTA_EXCEEDED');
    expect(response.body.error.details).toMatchObject({
      quota: 'swipes',
      limit: 1,
      remaining: 0,
      upgrade_available: true,
    });
    expect(response.body.error.details.resets_at).toMatch(/Z$/);
  });

  it('does not charge quota for a pass', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 1);
    await resetQuotas(viewer.user_id);

    const a = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });
    const b = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: a.user.id, action: 'pass' });

    // The single like is still available: passing cost nothing.
    const response = await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: b.user.id, action: 'like' });

    expect(response.status).toBe(201);
  });

  it('refunds the allowance when the write fails', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 2);
    await resetQuotas(viewer.user_id);

    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    // Duplicate swipe: the transaction fails on the unique index.
    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });

    const stats = await api
      .get(`${API_PREFIX}/discovery/dating/stats`)
      .set(authHeader(viewer.tokens));

    // One like landed, so one is spent. The rejected one must not be charged.
    expect(stats.body.data.swipe_quota.used).toBe(1);
  });

  it('does not cap a paid tier', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'advanced');
    await resetQuotas(viewer.user_id);

    const targets = await Promise.all([
      createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN }),
      createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN }),
      createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN }),
    ]);

    for (const target of targets) {
      const response = await api
        .post(SWIPE('dating'))
        .set(authHeader(viewer.tokens))
        .send({ target_id: target.user.id, action: 'like' });

      expect(response.status).toBe(201);
      expect(response.body.data.quota.is_unlimited).toBe(true);
    }
  });
});

describe('POST /discovery/:mode/rewind', () => {
  it('is premium', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    const response = await api.post(REWIND('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PREMIUM_REQUIRED');
    expect(response.body.error.details).toMatchObject({ upgrade_available: true });
  });

  it('restores the profile to the deck', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'basic');
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api.get(`${API_PREFIX}/discovery/dating/deck`).set(authHeader(viewer.tokens));
    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    const gone = await api
      .get(`${API_PREFIX}/discovery/dating/deck`)
      .set(authHeader(viewer.tokens));
    expect(gone.body.data).toEqual([]);

    const rewind = await api.post(REWIND('dating')).set(authHeader(viewer.tokens));
    expect(rewind.status).toBe(200);
    expect(rewind.body.data.restored_user_id).toBe(target.user.id);

    const back = await api
      .get(`${API_PREFIX}/discovery/dating/deck`)
      .set(authHeader(viewer.tokens));
    expect(back.body.data).toHaveLength(1);
    expect(back.body.data[0].user.id).toBe(target.user.id);
  });

  it('removes the match the rewound swipe created', async () => {
    const a = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const b = await createDiscoverableViewer({ mode: Mode.dating, coordinates: CAMDEN });
    await setTier(a.user_id, 'basic');

    await likeEachOther(a, b, Mode.dating);
    expect(await prisma.match.count()).toBe(1);

    const response = await api.post(REWIND('dating')).set(authHeader(a.tokens));

    // Keeping the match would leave a conversation neither person can trace,
    // and the unique index would stop the pair ever re-matching in this mode.
    expect(response.body.data.match_removed).toBe(true);
    expect(await prisma.match.count()).toBe(0);
  });

  it('gives the swipe allowance back', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'basic');
    await setFlag('basic', ENTITLEMENT_KEYS.DAILY_SWIPE_LIMIT, 5);
    await resetQuotas(viewer.user_id);

    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'like' });
    await api.post(REWIND('dating')).set(authHeader(viewer.tokens));

    const stats = await api
      .get(`${API_PREFIX}/discovery/dating/stats`)
      .set(authHeader(viewer.tokens));

    expect(stats.body.data.swipe_quota.used).toBe(0);
  });

  it('404s when there is nothing to rewind', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await setTier(viewer.user_id, 'basic');

    const response = await api.post(REWIND('dating')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(404);
  });

  it('only rewinds within the mode it was called for', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      also_modes: [Mode.fitness],
    });
    await setTier(viewer.user_id, 'basic');
    const target = await createDiscoverableUser({ mode: Mode.dating, coordinates: CAMDEN });

    await api
      .post(SWIPE('dating'))
      .set(authHeader(viewer.tokens))
      .send({ target_id: target.user.id, action: 'pass' });

    const response = await api.post(REWIND('fitness')).set(authHeader(viewer.tokens));

    expect(response.status).toBe(404);
    expect(await prisma.swipe.count()).toBe(1);
  });
});
