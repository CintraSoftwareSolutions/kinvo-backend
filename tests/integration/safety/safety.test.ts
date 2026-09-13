import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { LONDON, createBlock } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair, sendText } from '../../helpers/chat';

/**
 * Safety (spec §5.5, §5.7, Batch 12).
 *
 * THE RULE the spec is most emphatic about: reports are ANONYMOUS. The reported
 * user must never learn who reported them through any endpoint, notification,
 * or error message. Several tests here exist only to prove that negative.
 *
 * The spec also says "test the block rule hard here" — decks, matching, chat,
 * plans, and profile views must all respect it.
 */

const REPORTS = `${API_PREFIX}/reports`;
const BLOCKS = `${API_PREFIX}/blocks`;
const SAFETY = `${API_PREFIX}/safety`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('POST /reports', () => {
  it('files a report', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    const response = await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment', description: 'Abusive messages' });

    expect(response.status).toBe(201);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.reason).toBe('harassment');
    expect(response.body.data.status).toBe('open');
  });

  it('blocks atomically when asked (spec §5.7)', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    const response = await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment', also_block: true });

    expect(response.body.data.also_blocked).toBe(true);

    // One transaction or neither: a report filed without its block leaves
    // someone still exposed to the person they just reported.
    const block = await prisma.block.findFirst({
      where: { blocker_id: reporter.user_id, blocked_id: target.user_id },
    });
    expect(block).not.toBeNull();
  });

  it('rejects reporting yourself', async () => {
    const reporter = await createAuthenticatedUser();

    const response = await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: reporter.user_id, reason: 'spam_scam' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('allows reporting someone already blocked', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();
    await createBlock(reporter.user_id, target.user_id);

    const response = await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    // Block-then-report is the most common order of events, so the report path
    // deliberately does not apply the visibility filter.
    expect(response.status).toBe(201);
  });

  it('rejects an unknown reason', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    const response = await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'i_dont_like_them' });

    expect(response.status).toBe(400);
  });

  it('requires a token', async () => {
    const response = await api.post(REPORTS).send({ reported_id: 'x', reason: 'spam_scam' });

    expect(response.status).toBe(401);
  });
});

describe('reporter anonymity (spec §5.7)', () => {
  it('never lets the reported user list reports about them', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    const response = await api.get(REPORTS).set(authHeader(target.tokens));

    // The list returns reports you FILED. There is no endpoint at all for
    // reports about you — even a count would tell someone they are under
    // review, which changes behaviour before a moderator looks.
    expect(response.body.data).toEqual([]);
  });

  it('never names the reporter to an ordinary user', async () => {
    const reporter = await createAuthenticatedUser({ display_name: 'Whistleblower' });
    const target = await createAuthenticatedUser();

    await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    const mine = await api.get(REPORTS).set(authHeader(reporter.tokens));
    const theirs = await api.get(REPORTS).set(authHeader(target.tokens));

    expect(JSON.stringify(theirs.body)).not.toContain(reporter.user_id);
    expect(JSON.stringify(theirs.body)).not.toContain('Whistleblower');
    // Even the reporter's own view omits the id — nothing needs it.
    expect(JSON.stringify(mine.body)).not.toContain(reporter.user_id);
  });

  it('refuses the moderation queue to an ordinary user', async () => {
    const user = await createAuthenticatedUser();

    const response = await api.get(`${REPORTS}/review`).set(authHeader(user.tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'FORBIDDEN');
  });

  it('shows the reporter ONLY to a moderator', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();
    const moderator = await createAuthenticatedUser({ role: 'moderator' });

    await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    const response = await api.get(`${REPORTS}/review`).set(authHeader(moderator.tokens));

    // Moderators need it to spot coordinated reporting and retaliation. This is
    // the only place it is returned.
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].reporter_id).toBe(reporter.user_id);
  });

  it('answers identically whether or not the target has prior reports', async () => {
    const target = await createAuthenticatedUser();
    const first = await createAuthenticatedUser();
    const second = await createAuthenticatedUser();

    const a = await api
      .post(REPORTS)
      .set(authHeader(first.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    const b = await api
      .post(REPORTS)
      .set(authHeader(second.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    // A different response for an already-reported user would let someone probe
    // who has reports against them.
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body.data).sort()).toEqual(Object.keys(b.body.data).sort());
  });
});

describe('PATCH /reports/:id', () => {
  it('lets a moderator resolve a report', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();
    const moderator = await createAuthenticatedUser({ role: 'moderator' });

    const created = await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    const response = await api
      .patch(`${REPORTS}/${created.body.data.id}`)
      .set(authHeader(moderator.tokens))
      .send({ status: 'actioned', resolution_note: 'Account suspended' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('actioned');
    expect(response.body.data.reviewed_at).not.toBeNull();
  });

  it('refuses an ordinary user', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    const created = await api
      .post(REPORTS)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    const response = await api
      .patch(`${REPORTS}/${created.body.data.id}`)
      .set(authHeader(target.tokens))
      .send({ status: 'dismissed' });

    expect(response.status).toBe(403);
  });
});

describe('blocks', () => {
  it('blocks and lists', async () => {
    const user = await createAuthenticatedUser();
    const target = await createAuthenticatedUser({ display_name: 'Blocked Person' });

    const created = await api
      .post(BLOCKS)
      .set(authHeader(user.tokens))
      .send({ user_id: target.user_id });

    expect(created.status).toBe(201);
    expect(created.body.data.user.display_name).toBe('Blocked Person');

    const list = await api.get(BLOCKS).set(authHeader(user.tokens));
    expect(list.body.data).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const user = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    await api.post(BLOCKS).set(authHeader(user.tokens)).send({ user_id: target.user_id });
    const second = await api
      .post(BLOCKS)
      .set(authHeader(user.tokens))
      .send({ user_id: target.user_id });

    // Pressing the button twice is not a state worth an error.
    expect(second.status).toBe(201);
    expect(await prisma.block.count()).toBe(1);
  });

  it('unmatches an active match on block', async () => {
    const { a, b } = await matchPair(Mode.dating);

    await api.post(BLOCKS).set(authHeader(a.tokens)).send({ user_id: b.user_id });

    const match = await prisma.match.findFirstOrThrow();
    // A block alone would leave the match visible and frozen, which is right
    // for a lapsed match and wrong for one deliberately cut.
    expect(match.status).toBe('unmatched');
  });

  it('unblocks without restoring the match', async () => {
    const { a, b } = await matchPair(Mode.dating);

    await api.post(BLOCKS).set(authHeader(a.tokens)).send({ user_id: b.user_id });
    const response = await api.delete(`${BLOCKS}/${b.user_id}`).set(authHeader(a.tokens));

    expect(response.status).toBe(200);

    // Unblocking means "I will see them again", not "undo everything".
    const match = await prisma.match.findFirstOrThrow();
    expect(match.status).toBe('unmatched');
  });

  it('404s unblocking someone who is not blocked', async () => {
    const user = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    const response = await api.delete(`${BLOCKS}/${target.user_id}`).set(authHeader(user.tokens));

    expect(response.status).toBe(404);
  });

  it('lists only blocks YOU created, never blocks against you', async () => {
    const user = await createAuthenticatedUser();
    const other = await createAuthenticatedUser();
    await createBlock(other.user_id, user.user_id);

    const response = await api.get(BLOCKS).set(authHeader(user.tokens));

    // Listing who blocked you tells you exactly that, which is what the whole
    // 404-not-403 rule exists to prevent.
    expect(response.body.data).toEqual([]);
  });

  it('rejects blocking yourself', async () => {
    const user = await createAuthenticatedUser();

    const response = await api
      .post(BLOCKS)
      .set(authHeader(user.tokens))
      .send({ user_id: user.user_id });

    expect(response.status).toBe(400);
  });
});

describe('the block rule holds across the product (spec §5.5)', () => {
  it('removes them from the deck, chat, and profile view at once', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const other = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    // A live relationship first, so there is something to lose.
    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(other.tokens))
      .send({ target_id: viewer.user_id, action: 'like' });
    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(viewer.tokens))
      .send({ target_id: other.user_id, action: 'like' });

    await api.post(BLOCKS).set(authHeader(viewer.tokens)).send({ user_id: other.user_id });

    const deck = await api
      .get(`${API_PREFIX}/discovery/dating/deck`)
      .set(authHeader(viewer.tokens));
    const profile = await api
      .get(`${API_PREFIX}/users/${other.user_id}`)
      .set(authHeader(viewer.tokens));
    const matches = await api.get(`${API_PREFIX}/matches`).set(authHeader(viewer.tokens));

    expect(deck.body.data.map((c: { user: { id: string } }) => c.user.id)).not.toContain(
      other.user_id,
    );
    // 404, not 403 — a 403 would confirm the account exists.
    expect(profile.status).toBe(404);
    expect(matches.body.data).toEqual([]);
  });

  it('freezes the conversation for BOTH sides', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await sendText(a, conversation_id, 'before');

    await api.post(BLOCKS).set(authHeader(a.tokens)).send({ user_id: b.user_id });

    const fromBlocker = await sendText(a, conversation_id, 'after');
    const fromBlocked = await sendText(b, conversation_id, 'after');

    expect(fromBlocker.status).toBe(403);
    expect(fromBlocked.status).toBe(403);
    // Identical, or a block is confirmable by elimination.
    expect(fromBlocker.body.error.message).toBe(fromBlocked.body.error.message);
  });
});

describe('trusted contacts', () => {
  it('creates and lists', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const created = await api
      .post(`${SAFETY}/contacts`)
      .set(authHeader(user.tokens))
      .send({ name: 'Sister', phone: '+447700900123', relationship: 'family' });

    expect(created.status).toBe(201);

    const list = await api.get(`${SAFETY}/contacts`).set(authHeader(user.tokens));
    expect(list.body.data.contacts).toHaveLength(1);
    expect(list.body.data.contacts[0].name).toBe('Sister');
  });

  it('requires a phone or an email', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(`${SAFETY}/contacts`)
      .set(authHeader(user.tokens))
      .send({ name: 'Nobody' });

    // A contact with no way to reach them is decoration, and the moment it
    // matters is the moment nobody checks whether it works.
    expect(response.status).toBe(400);
  });

  it('caps the number of contacts', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    for (let i = 0; i < 5; i += 1) {
      await api
        .post(`${SAFETY}/contacts`)
        .set(authHeader(user.tokens))
        .send({ name: `Contact ${i}`, email: `c${i}@example.com` });
    }

    const response = await api
      .post(`${SAFETY}/contacts`)
      .set(authHeader(user.tokens))
      .send({ name: 'One too many', email: 'x@example.com' });

    expect(response.status).toBe(400);
  });

  it('404s on someone else’s contact', async () => {
    const owner = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const created = await api
      .post(`${SAFETY}/contacts`)
      .set(authHeader(owner.tokens))
      .send({ name: 'Private', email: 'p@example.com' });

    const response = await api
      .delete(`${SAFETY}/contacts/${created.body.data.id}`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
    expect(await prisma.trustedContact.count()).toBe(1);
  });
});

describe('live location (spec §5.7)', () => {
  it('starts with an explicit expiry', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(`${SAFETY}/location`)
      .set(authHeader(user.tokens))
      .send({ duration_minutes: 60 });

    expect(response.status).toBe(201);
    expect(response.body.data.is_active).toBe(true);
    // There is no way to create a session that does not end.
    expect(new Date(response.body.data.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('caps the duration', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(`${SAFETY}/location`)
      .set(authHeader(user.tokens))
      .send({ duration_minutes: 10_000 });

    expect(response.status).toBe(400);
  });

  it('replaces a previous session rather than running two', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api.post(`${SAFETY}/location`).set(authHeader(user.tokens)).send({});
    await api.post(`${SAFETY}/location`).set(authHeader(user.tokens)).send({});

    const active = await prisma.liveLocationSession.count({ where: { ended_at: null } });
    // A second concurrent session leaves a trail the user cannot see from the
    // one screen showing "sharing".
    expect(active).toBe(1);
  });

  it('records pings and returns the trail to its owner', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const session = await api.post(`${SAFETY}/location`).set(authHeader(user.tokens)).send({});
    const id = session.body.data.id;

    await api
      .post(`${SAFETY}/location/${id}/ping`)
      .set(authHeader(user.tokens))
      .send({ latitude: 51.5072, longitude: -0.1276, accuracy_metres: 10 });

    const trail = await api.get(`${SAFETY}/location/${id}/trail`).set(authHeader(user.tokens));

    expect(trail.body.data.pings).toHaveLength(1);
    expect(trail.body.data.pings[0].latitude).toBeCloseTo(51.5072, 3);
  });

  it('DESTROYS the trail when sharing stops', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const session = await api.post(`${SAFETY}/location`).set(authHeader(user.tokens)).send({});
    const id = session.body.data.id;

    await api
      .post(`${SAFETY}/location/${id}/ping`)
      .set(authHeader(user.tokens))
      .send({ latitude: 51.5072, longitude: -0.1276 });

    await api.delete(`${SAFETY}/location/${id}`).set(authHeader(user.tokens));

    // spec §5.7: retain no historical trail beyond the immediate need. "Stop
    // sharing" that leaves a movement history is not stopping sharing.
    expect(await prisma.liveLocationPing.count()).toBe(0);
    // The session row survives — a safety investigation needs to know sharing
    // happened.
    expect(await prisma.liveLocationSession.count()).toBe(1);
  });

  it('refuses pings on an expired session rather than extending it', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const session = await api.post(`${SAFETY}/location`).set(authHeader(user.tokens)).send({});
    const id = session.body.data.id;

    await prisma.liveLocationSession.update({
      where: { id },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const response = await api
      .post(`${SAFETY}/location/${id}/ping`)
      .set(authHeader(user.tokens))
      .send({ latitude: 51.5, longitude: -0.1 });

    // The TTL is the user's consent boundary; a client that keeps sending must
    // not be able to push it outward.
    expect(response.status).toBe(404);
  });

  it('never returns someone else’s trail', async () => {
    const owner = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const session = await api.post(`${SAFETY}/location`).set(authHeader(owner.tokens)).send({});

    const response = await api
      .get(`${SAFETY}/location/${session.body.data.id}/trail`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
  });

  it('rejects impossible coordinates', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const session = await api.post(`${SAFETY}/location`).set(authHeader(user.tokens)).send({});

    const response = await api
      .post(`${SAFETY}/location/${session.body.data.id}/ping`)
      .set(authHeader(user.tokens))
      .send({ latitude: 200, longitude: 0 });

    expect(response.status).toBe(400);
  });
});

describe('emergency', () => {
  it('records the event and tells the user who was alerted', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api
      .post(`${SAFETY}/contacts`)
      .set(authHeader(user.tokens))
      .send({ name: 'Sister', phone: '+447700900123' });

    const response = await api
      .post(`${SAFETY}/emergency`)
      .set(authHeader(user.tokens))
      .send({ note: 'Feeling unsafe', latitude: 51.5072, longitude: -0.1276 });

    expect(response.status).toBe(201);
    expect(response.body.data.contacts_notified).toBe(1);
    expect(response.body.data.location.latitude).toBeCloseTo(51.5072, 3);
  });

  it('still records when there are no contacts, and says so', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.post(`${SAFETY}/emergency`).set(authHeader(user.tokens)).send({});

    // Someone pressing this button is having the worst moment this app will be
    // part of. "You have no contacts" is a far better outcome than an error.
    expect(response.status).toBe(201);
    expect(response.body.data.contacts_notified).toBe(0);
  });

  it('sends an unmutable safety notification', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api.post(`${SAFETY}/emergency`).set(authHeader(user.tokens)).send({});

    const notifications = await prisma.notification.findMany({
      where: { user_id: user.user_id, category: 'safety' },
    });

    expect(notifications).toHaveLength(1);
  });

  it('requires both coordinates or neither', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(`${SAFETY}/emergency`)
      .set(authHeader(user.tokens))
      .send({ latitude: 51.5 });

    expect(response.status).toBe(400);
  });
});
