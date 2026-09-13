import { API_PREFIX } from '@config/constants';
import { MatchStatus, Mode, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { CAMDEN, LONDON, createBlock } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import {
  connectRedis,
  disconnectRedis,
  seedEntitlements,
  setTier,
} from '../../helpers/entitlements';
import { matchPair } from '../../helpers/chat';

/**
 * Matches (spec §5.4, Batch 8).
 *
 * Every match here is created the only way one can be created: two people
 * liking each other through the API. Building match rows directly would test a
 * shape the product cannot actually produce.
 */

const MATCHES = `${API_PREFIX}/matches`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('GET /matches', () => {
  it('lists a match with everything needed to render the row (spec §4.7)', async () => {
    const { a, b } = await matchPair(Mode.dating);

    const response = await api.get(MATCHES).set(authHeader(a.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toHaveLength(1);

    const match = response.body.data[0];
    expect(match.mode).toBe('dating');
    expect(match.user.id).toBe(b.user_id);
    expect(match).toHaveProperty('conversation_id');
    expect(match).toHaveProperty('unread_count', 0);
    expect(match).toHaveProperty('last_message_preview', null);
    expect(match.is_writable).toBe(true);
    expect(match.is_expired).toBe(false);
  });

  it('shows the match to both sides, each seeing the other', async () => {
    const { a, b } = await matchPair(Mode.dating);

    const forA = await api.get(MATCHES).set(authHeader(a.tokens));
    const forB = await api.get(MATCHES).set(authHeader(b.tokens));

    expect(forA.body.data[0].user.id).toBe(b.user_id);
    expect(forB.body.data[0].user.id).toBe(a.user_id);
  });

  it('returns an empty array, never null, with no matches', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(MATCHES).set(authHeader(viewer.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('filters by mode', async () => {
    const { a, b } = await matchPair(Mode.dating, [Mode.study_buddy]);
    await matchPair(Mode.study_buddy, [], { a, b });

    const dating = await api.get(`${MATCHES}?mode=dating`).set(authHeader(a.tokens));
    const study = await api.get(`${MATCHES}?mode=study_buddy`).set(authHeader(a.tokens));
    const all = await api.get(MATCHES).set(authHeader(a.tokens));

    expect(dating.body.data).toHaveLength(1);
    expect(study.body.data).toHaveLength(1);
    // The same pair, two independent matches in two modes.
    expect(all.body.data).toHaveLength(2);
    expect(dating.body.data[0].id).not.toBe(study.body.data[0].id);
  });

  it('separates the Archived tab from Matches', async () => {
    const { a } = await matchPair(Mode.dating);

    const before = await api.get(MATCHES).set(authHeader(a.tokens));
    const conversationId = before.body.data[0].conversation_id;

    await api
      .patch(`${API_PREFIX}/conversations/${conversationId}`)
      .set(authHeader(a.tokens))
      .send({ is_archived: true });

    const active = await api.get(MATCHES).set(authHeader(a.tokens));
    const archived = await api.get(`${MATCHES}?archived=true`).set(authHeader(a.tokens));

    expect(active.body.data).toEqual([]);
    expect(archived.body.data).toHaveLength(1);
  });

  it('archiving is per user, not shared', async () => {
    const { a, b } = await matchPair(Mode.dating);

    const before = await api.get(MATCHES).set(authHeader(a.tokens));
    await api
      .patch(`${API_PREFIX}/conversations/${before.body.data[0].conversation_id}`)
      .set(authHeader(a.tokens))
      .send({ is_archived: true });

    const forB = await api.get(MATCHES).set(authHeader(b.tokens));

    expect(forB.body.data).toHaveLength(1);
  });

  it('hides a match whose other participant deleted their account', async () => {
    const { a, b } = await matchPair(Mode.dating);

    await prisma.user.update({ where: { id: b.user_id }, data: { deleted_at: new Date() } });

    const response = await api.get(MATCHES).set(authHeader(a.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('requires a token', async () => {
    const response = await api.get(MATCHES);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('block visibility on matches (DECISIONS.md §1.2e)', () => {
  it('keeps a blocked pair’s match listed but not writable', async () => {
    const { a, b } = await matchPair(Mode.dating);

    await createBlock(a.user_id, b.user_id);

    const response = await api.get(MATCHES).set(authHeader(a.tokens));

    // Visible, so history does not vanish mid-scroll and read as data loss.
    expect(response.body.data).toHaveLength(1);
    // Frozen, so the block actually means something.
    expect(response.body.data[0].is_writable).toBe(false);
  });

  it('freezes it for the blocked side too, with no hint of who blocked whom', async () => {
    const { a, b } = await matchPair(Mode.dating);

    await createBlock(a.user_id, b.user_id);

    const forA = await api.get(MATCHES).set(authHeader(a.tokens));
    const forB = await api.get(MATCHES).set(authHeader(b.tokens));

    expect(forA.body.data[0].is_writable).toBe(false);
    expect(forB.body.data[0].is_writable).toBe(false);
  });
});

describe('GET /matches/:id', () => {
  it('returns one match', async () => {
    const { a, b } = await matchPair(Mode.dating);
    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    const response = await api.get(`${MATCHES}/${list.body.data[0].id}`).set(authHeader(a.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.user.id).toBe(b.user_id);
  });

  it('404s on someone else’s match, never 403', async () => {
    const { a } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    const response = await api
      .get(`${MATCHES}/${list.body.data[0].id}`)
      .set(authHeader(stranger.tokens));

    // A 403 would confirm the match exists and belongs to someone.
    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });

  it('404s for a match id that never existed', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .get(`${MATCHES}/00000000-0000-4000-8000-000000000000`)
      .set(authHeader(viewer.tokens));

    expect(response.status).toBe(404);
  });

  it('rejects an id that is not a uuid', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(`${MATCHES}/not-a-uuid`).set(authHeader(viewer.tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });
});

describe('DELETE /matches/:id', () => {
  it('unmatches, and removes it for BOTH sides', async () => {
    const { a, b } = await matchPair(Mode.dating);
    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    const response = await api
      .delete(`${MATCHES}/${list.body.data[0].id}`)
      .set(authHeader(a.tokens));

    expect(response.status).toBe(200);

    const forA = await api.get(MATCHES).set(authHeader(a.tokens));
    const forB = await api.get(MATCHES).set(authHeader(b.tokens));

    // An unmatch is symmetric. One person leaving does not leave the other
    // with a live conversation.
    expect(forA.body.data).toEqual([]);
    expect(forB.body.data).toEqual([]);
  });

  it('records who unmatched, for a later report investigation', async () => {
    const { a } = await matchPair(Mode.dating);
    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    await api.delete(`${MATCHES}/${list.body.data[0].id}`).set(authHeader(a.tokens));

    const match = await prisma.match.findUniqueOrThrow({ where: { id: list.body.data[0].id } });

    expect(match.status).toBe(MatchStatus.unmatched);
    expect(match.unmatched_by_id).toBe(a.user_id);
    expect(match.unmatched_at).not.toBeNull();
  });

  it('leaves the swipes in place, so the pair is not offered again', async () => {
    const { a } = await matchPair(Mode.dating);
    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    await api.delete(`${MATCHES}/${list.body.data[0].id}`).set(authHeader(a.tokens));

    expect(await prisma.swipe.count()).toBe(2);
  });

  it('404s on someone else’s match', async () => {
    const { a } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: CAMDEN });
    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    const response = await api
      .delete(`${MATCHES}/${list.body.data[0].id}`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
    expect(await prisma.match.count({ where: { status: MatchStatus.active } })).toBe(1);
  });
});

describe('POST /matches/:id/extend', () => {
  it('is premium', async () => {
    const { a } = await matchPair(Mode.dating);
    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    const response = await api
      .post(`${MATCHES}/${list.body.data[0].id}/extend`)
      .set(authHeader(a.tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PREMIUM_REQUIRED');
  });

  it('pushes the expiry out and counts the extension', async () => {
    const { a } = await matchPair(Mode.dating);
    await setTier(a.user_id, 'advanced');

    const list = await api.get(MATCHES).set(authHeader(a.tokens));
    const before = new Date(list.body.data[0].expires_at);

    const response = await api
      .post(`${MATCHES}/${list.body.data[0].id}/extend`)
      .set(authHeader(a.tokens));

    expect(response.status).toBe(200);
    expect(new Date(response.body.data.expires_at).getTime()).toBeGreaterThan(before.getTime());
    expect(response.body.data.extension_count).toBe(1);
  });

  it('extends from the current expiry, not from now', async () => {
    const { a } = await matchPair(Mode.dating);
    await setTier(a.user_id, 'advanced');

    const list = await api.get(MATCHES).set(authHeader(a.tokens));
    const before = new Date(list.body.data[0].expires_at);

    const response = await api
      .post(`${MATCHES}/${list.body.data[0].id}/extend`)
      .set(authHeader(a.tokens));

    // Extending a match with days still on it must add the window, not reset
    // it to a shorter one starting today.
    const gained = new Date(response.body.data.expires_at).getTime() - before.getTime();
    expect(gained).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  });

  it('brings an expired match back to life', async () => {
    const { a } = await matchPair(Mode.dating);
    await setTier(a.user_id, 'advanced');

    const list = await api.get(MATCHES).set(authHeader(a.tokens));
    await prisma.match.update({
      where: { id: list.body.data[0].id },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });

    const expired = await api.get(`${MATCHES}/${list.body.data[0].id}`).set(authHeader(a.tokens));
    expect(expired.body.data.is_expired).toBe(true);
    expect(expired.body.data.is_writable).toBe(false);

    const response = await api
      .post(`${MATCHES}/${list.body.data[0].id}/extend`)
      .set(authHeader(a.tokens));

    expect(response.body.data.is_expired).toBe(false);
    expect(response.body.data.is_writable).toBe(true);
  });

  it('404s on someone else’s match even for a paying user', async () => {
    const { a } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: CAMDEN });
    await setTier(stranger.user_id, 'advanced');

    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    const response = await api
      .post(`${MATCHES}/${list.body.data[0].id}/extend`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
  });
});

describe('expiry', () => {
  it('treats a lapsed match as expired at read time, with no sweeper', async () => {
    const { a } = await matchPair(Mode.dating);
    const list = await api.get(MATCHES).set(authHeader(a.tokens));

    await prisma.match.update({
      where: { id: list.body.data[0].id },
      // Status still says active — exactly the state a late sweeper leaves.
      data: { expires_at: new Date(Date.now() - 1000), status: MatchStatus.active },
    });

    const response = await api.get(MATCHES).set(authHeader(a.tokens));

    expect(response.body.data[0].is_expired).toBe(true);
    expect(response.body.data[0].is_writable).toBe(false);
  });
});
