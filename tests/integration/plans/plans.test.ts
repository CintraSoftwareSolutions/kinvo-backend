import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { LONDON, createBlock } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair } from '../../helpers/chat';

/**
 * Plans (spec §5.8, Batch 12).
 *
 * THE RULE most of these tests protect: a DRAFT is visible only to its creator.
 * The other person sees nothing until it is proposed. Someone sketching an idea
 * they might not send must not have it appear on the other person's screen —
 * that is the whole difference between a draft and a message.
 */

const PLANS = `${API_PREFIX}/plans`;

function soon(hours = 24): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('drafts are private (spec §5.8)', () => {
  it('creates a draft the other person cannot see', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'The ramen place', scheduled_at: soon() });

    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('draft');

    const forB = await api.get(PLANS).set(authHeader(b.tokens));
    expect(forB.body.data).toEqual([]);

    // Not even by id.
    const direct = await api.get(`${PLANS}/${created.body.data.id}`).set(authHeader(b.tokens));
    expect(direct.status).toBe(404);
  });

  it('sends no notification for a draft', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Somewhere', scheduled_at: soon() });

    const notifications = await prisma.notification.count({
      where: { user_id: b.user_id, category: 'plan_update' },
    });

    // Notifying on a draft would defeat the point of drafts entirely.
    expect(notifications).toBe(0);
  });

  it('reveals it the moment it is proposed', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'The ramen place', scheduled_at: soon() });

    await api.post(`${PLANS}/${created.body.data.id}/propose`).set(authHeader(a.tokens));

    const forB = await api.get(PLANS).set(authHeader(b.tokens));

    expect(forB.body.data).toHaveLength(1);
    expect(forB.body.data[0].awaiting_my_response).toBe(true);

    const notifications = await prisma.notification.count({
      where: { user_id: b.user_id, category: 'plan_update' },
    });
    expect(notifications).toBe(1);
  });

  it('lists drafts separately from pending', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Draft', scheduled_at: soon() });

    const drafts = await api.get(`${PLANS}?drafts=true`).set(authHeader(a.tokens));
    const pending = await api.get(`${PLANS}?tab=pending`).set(authHeader(a.tokens));

    // Pending means waiting on the other person; a draft is waiting on you.
    expect(drafts.body.data).toHaveLength(1);
    expect(pending.body.data).toEqual([]);
  });
});

describe('POST /plans', () => {
  it('creates and proposes in one call', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const response = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });

    expect(response.status).toBe(201);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.status).toBe('proposed');
    expect(response.body.data.is_mine).toBe(true);
  });

  it('requires a venue or a location', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const response = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, scheduled_at: soon() });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('refuses to propose without a time', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const response = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', propose: true });

    // The other person cannot answer "yes" to an unscheduled plan.
    expect(response.status).toBe(400);
  });

  it('refuses a time in the past', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const response = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(-24) });

    expect(response.status).toBe(400);
  });

  it('404s on a match the caller is not in', async () => {
    const { match_id } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(PLANS)
      .set(authHeader(stranger.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon() });

    expect(response.status).toBe(404);
  });

  it('refuses on a blocked pair, with the same error as a closed conversation', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);
    await createBlock(b.user_id, a.user_id);

    const response = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon() });

    // Blocking unmatches, so this is a 404 — and a 404 is also what a stranger
    // gets, which is the point.
    expect([403, 404]).toContain(response.status);
  });

  it('requires a token', async () => {
    const response = await api.post(PLANS).send({ match_id: 'x' });

    expect(response.status).toBe(401);
  });
});

describe('responding', () => {
  async function proposed() {
    const pair = await matchPair(Mode.dating);
    const created = await api.post(PLANS).set(authHeader(pair.a.tokens)).send({
      match_id: pair.match_id,
      custom_location: 'The ramen place',
      scheduled_at: soon(),
      propose: true,
    });

    return { ...pair, plan_id: created.body.data.id as string };
  }

  it('confirms on accept and tells the proposer', async () => {
    const { a, b, plan_id } = await proposed();

    const response = await api
      .post(`${PLANS}/${plan_id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: true });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('confirmed');

    const forProposer = await prisma.notification.findMany({
      where: { user_id: a.user_id, title: 'Plan confirmed' },
    });
    expect(forProposer).toHaveLength(1);
  });

  it('declines', async () => {
    const { b, plan_id } = await proposed();

    const response = await api
      .post(`${PLANS}/${plan_id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: false });

    expect(response.body.data.status).toBe('declined');
  });

  it('refuses to let the proposer accept their own plan', async () => {
    const { a, plan_id } = await proposed();

    const response = await api
      .post(`${PLANS}/${plan_id}/respond`)
      .set(authHeader(a.tokens))
      .send({ accept: true });

    // Otherwise someone could produce a confirmed meeting the other person
    // never agreed to.
    expect(response.status).toBe(400);
  });

  it('refuses a second response', async () => {
    const { b, plan_id } = await proposed();

    await api.post(`${PLANS}/${plan_id}/respond`).set(authHeader(b.tokens)).send({ accept: true });

    const response = await api
      .post(`${PLANS}/${plan_id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: false });

    expect(response.status).toBe(400);
  });
});

describe('editing and cancelling', () => {
  it('lets the creator edit a draft', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'First idea', scheduled_at: soon() });

    const response = await api
      .patch(`${PLANS}/${created.body.data.id}`)
      .set(authHeader(a.tokens))
      .send({ custom_location: 'Better idea' });

    expect(response.body.data.custom_location).toBe('Better idea');
  });

  it('refuses to let the other person edit a proposal', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });

    const response = await api
      .patch(`${PLANS}/${created.body.data.id}`)
      .set(authHeader(b.tokens))
      .send({ custom_location: 'Somewhere else' });

    // Editing someone else's proposal would let one side change the time after
    // the other accepted it.
    expect(response.status).toBe(404);
  });

  it('refuses to edit a confirmed plan', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });

    await api
      .post(`${PLANS}/${created.body.data.id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: true });

    const response = await api
      .patch(`${PLANS}/${created.body.data.id}`)
      .set(authHeader(a.tokens))
      .send({ custom_location: 'Moved' });

    expect(response.status).toBe(400);
  });

  it('lets either participant cancel', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });

    const response = await api
      .post(`${PLANS}/${created.body.data.id}/cancel`)
      .set(authHeader(b.tokens))
      .send({ reason: 'Something came up' });

    expect(response.body.data.status).toBe('cancelled');
  });

  it('does not announce cancelling a draft', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Never sent', scheduled_at: soon() });

    await api.post(`${PLANS}/${created.body.data.id}/cancel`).set(authHeader(a.tokens)).send({});

    // Announcing this would tell them about a plan that was never sent.
    expect(
      await prisma.notification.count({ where: { user_id: b.user_id, category: 'plan_update' } }),
    ).toBe(0);
  });
});

describe('tabs (spec §5.8)', () => {
  it('separates upcoming, pending, and history', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const confirmed = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Confirmed', scheduled_at: soon(48), propose: true });
    await api
      .post(`${PLANS}/${confirmed.body.data.id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: true });

    await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Pending', scheduled_at: soon(72), propose: true });

    const cancelled = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cancelled', scheduled_at: soon(96), propose: true });
    await api.post(`${PLANS}/${cancelled.body.data.id}/cancel`).set(authHeader(a.tokens)).send({});

    const upcoming = await api.get(`${PLANS}?tab=upcoming`).set(authHeader(a.tokens));
    const pending = await api.get(`${PLANS}?tab=pending`).set(authHeader(a.tokens));
    const history = await api.get(`${PLANS}?tab=history`).set(authHeader(a.tokens));

    expect(upcoming.body.data.map((p: { custom_location: string }) => p.custom_location)).toEqual([
      'Confirmed',
    ]);
    expect(pending.body.data.map((p: { custom_location: string }) => p.custom_location)).toEqual([
      'Pending',
    ]);
    expect(history.body.data.map((p: { custom_location: string }) => p.custom_location)).toEqual([
      'Cancelled',
    ]);
  });
});

describe('sharing with trusted contacts (spec §5.7)', () => {
  it('shares a confirmed plan', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const contact = await api
      .post(`${API_PREFIX}/safety/contacts`)
      .set(authHeader(a.tokens))
      .send({ name: 'Sister', phone: '+447700900123' });

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });

    await api
      .post(`${PLANS}/${created.body.data.id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: true });

    const response = await api
      .post(`${PLANS}/${created.body.data.id}/share`)
      .set(authHeader(a.tokens))
      .send({ contact_ids: [contact.body.data.id] });

    expect(response.status).toBe(200);
    expect(response.body.data.shared).toBe(1);
  });

  it('refuses to share a plan that was never accepted', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const contact = await api
      .post(`${API_PREFIX}/safety/contacts`)
      .set(authHeader(a.tokens))
      .send({ name: 'Sister', phone: '+447700900123' });

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });

    const response = await api
      .post(`${PLANS}/${created.body.data.id}/share`)
      .set(authHeader(a.tokens))
      .send({ contact_ids: [contact.body.data.id] });

    // Telling someone's sister about a plan that was never accepted is noise,
    // and it leaks the other person's availability before they agreed.
    expect(response.status).toBe(400);
  });

  it('refuses another user’s contact id', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const theirContact = await api
      .post(`${API_PREFIX}/safety/contacts`)
      .set(authHeader(b.tokens))
      .send({ name: 'Their sister', phone: '+447700900999' });

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });
    await api
      .post(`${PLANS}/${created.body.data.id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: true });

    const response = await api
      .post(`${PLANS}/${created.body.data.id}/share`)
      .set(authHeader(a.tokens))
      .send({ contact_ids: [theirContact.body.data.id] });

    expect(response.status).toBe(404);
  });
});
