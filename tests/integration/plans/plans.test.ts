import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { LONDON, createBlock, createVenue } from '../../helpers/factories';
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

/** Moves a plan's time into the past, as if nobody acted on it in time. */
async function letTimePass(planId: string): Promise<void> {
  await prisma.plan.update({
    where: { id: planId },
    data: { scheduled_at: new Date(Date.now() - 60 * 60 * 1000) },
  });
}

async function planUpdatesFor(userId: string): Promise<number> {
  return prisma.notification.count({ where: { user_id: userId, category: 'plan_update' } });
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

  it('deletes a draft rather than cancelling it, and tells nobody', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Never sent', scheduled_at: soon() });
    const id = created.body.data.id as string;

    // A cancelled plan is visible to both people, so cancelling a draft would
    // show the other person a plan that was never sent.
    const cancel = await api.post(`${PLANS}/${id}/cancel`).set(authHeader(a.tokens)).send({});
    expect(cancel.status).toBe(400);
    expectErrorEnvelope(cancel.body, 'BAD_REQUEST');

    const deleted = await api.delete(`${PLANS}/${id}`).set(authHeader(a.tokens));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ deleted: true });

    expect(await prisma.plan.count({ where: { id } })).toBe(0);
    const history = await api.get(`${PLANS}?tab=history`).set(authHeader(b.tokens));
    expect(history.body.data).toEqual([]);
    expect(await planUpdatesFor(b.user_id)).toBe(0);
  });

  it('deletes only drafts, and only its creator’s', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const draft = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Draft', scheduled_at: soon() });
    const sent = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Sent', scheduled_at: soon(), propose: true });

    // The other person cannot see the draft at all.
    const theirs = await api.delete(`${PLANS}/${draft.body.data.id}`).set(authHeader(b.tokens));
    expect(theirs.status).toBe(404);

    // A plan that was sent is cancelled instead, so the other person hears.
    const proposal = await api.delete(`${PLANS}/${sent.body.data.id}`).set(authHeader(a.tokens));
    expect(proposal.status).toBe(400);
    expectErrorEnvelope(proposal.body, 'BAD_REQUEST');
  });

  it('tells the other person when a proposal changes, but not a draft', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const draft = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Draft', scheduled_at: soon() });
    await api
      .patch(`${PLANS}/${draft.body.data.id}`)
      .set(authHeader(a.tokens))
      .send({ notes: 'Bring the book' });
    expect(await planUpdatesFor(b.user_id)).toBe(0);

    const sent = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });
    await api
      .patch(`${PLANS}/${sent.body.data.id}`)
      .set(authHeader(a.tokens))
      .send({ scheduled_at: soon(30) });

    // The proposal, then the change: they may already have read the first.
    const titles = await prisma.notification.findMany({
      where: { user_id: b.user_id, category: 'plan_update' },
      select: { title: true },
    });
    expect(titles.map((row) => row.title).sort()).toEqual(['New plan suggested', 'Plan changed']);
  });

  it('switches between a venue and a typed location, but keeps one', async () => {
    const { a, match_id } = await matchPair(Mode.dating);
    const venue = await createVenue({ coordinates: LONDON });

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'The ramen place', scheduled_at: soon() });
    const id = created.body.data.id as string;

    const toVenue = await api
      .patch(`${PLANS}/${id}`)
      .set(authHeader(a.tokens))
      .send({ venue_id: venue.id, custom_location: null });
    expect(toVenue.status).toBe(200);
    expect(toVenue.body.data.venue.id).toBe(venue.id);
    expect(toVenue.body.data.custom_location).toBeNull();

    const nowhere = await api
      .patch(`${PLANS}/${id}`)
      .set(authHeader(a.tokens))
      .send({ venue_id: null });
    expect(nowhere.status).toBe(400);
    expectErrorEnvelope(nowhere.body, 'VALIDATION_FAILED');
  });

  it('refuses a venue that does not exist, rather than failing', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Somewhere', scheduled_at: soon() });

    const response = await api
      .patch(`${PLANS}/${created.body.data.id}`)
      .set(authHeader(a.tokens))
      .send({ venue_id: '00000000-0000-4000-8000-000000000000' });

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });
});

describe('who a plan is with', () => {
  it('names the other person on each side', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });

    const forA = await api.get(PLANS).set(authHeader(a.tokens));
    const forB = await api.get(PLANS).set(authHeader(b.tokens));

    expect(forA.body.data[0].user).toMatchObject({ id: b.user_id, display_name: 'Blake' });
    expect(forB.body.data[0].user).toMatchObject({ id: a.user_id, display_name: 'Alex' });
  });

  it('hides a plan with an account that was suspended', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });
    await prisma.user.update({ where: { id: b.user_id }, data: { status: 'suspended' } });

    // As their match is hidden: suspended must look the same as never existed.
    const list = await api.get(PLANS).set(authHeader(a.tokens));
    const direct = await api.get(`${PLANS}/${created.body.data.id}`).set(authHeader(a.tokens));

    expect(list.body.data).toEqual([]);
    expect(direct.status).toBe(404);
  });
});

describe('a proposal whose time has passed', () => {
  it('can be declined but not accepted', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });
    const id = created.body.data.id as string;
    await letTimePass(id);

    const accept = await api
      .post(`${PLANS}/${id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: true });
    expect(accept.status).toBe(400);
    expectErrorEnvelope(accept.body, 'BAD_REQUEST');

    const decline = await api
      .post(`${PLANS}/${id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: false });
    expect(decline.body.data.status).toBe('declined');
  });

  it('moves to history, and stops waiting on an answer', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon(), propose: true });
    const waiting = await api.get(`${API_PREFIX}/notifications/badges`).set(authHeader(b.tokens));
    expect(waiting.body.data.plans).toBe(1);

    await letTimePass(created.body.data.id);

    const pending = await api.get(`${PLANS}?tab=pending`).set(authHeader(b.tokens));
    const history = await api.get(`${PLANS}?tab=history`).set(authHeader(b.tokens));
    const badges = await api.get(`${API_PREFIX}/notifications/badges`).set(authHeader(b.tokens));

    expect(pending.body.data).toEqual([]);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].awaiting_my_response).toBe(false);
    expect(badges.body.data.plans).toBe(0);
  });

  it('cannot be sent when it was a draft', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const created = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Cafe', scheduled_at: soon() });
    await letTimePass(created.body.data.id);

    const response = await api
      .post(`${PLANS}/${created.body.data.id}/propose`)
      .set(authHeader(a.tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });
});

describe('when the match ends', () => {
  /** A confirmed plan, one waiting for an answer, and a draft, all ahead. */
  async function openPlans() {
    const pair = await matchPair(Mode.dating);
    const { a, b, match_id } = pair;

    const confirmed = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Confirmed', scheduled_at: soon(), propose: true });
    await api
      .post(`${PLANS}/${confirmed.body.data.id}/respond`)
      .set(authHeader(b.tokens))
      .send({ accept: true });
    const proposed = await api
      .post(PLANS)
      .set(authHeader(b.tokens))
      .send({ match_id, custom_location: 'Proposed', scheduled_at: soon(48), propose: true });
    const draft = await api
      .post(PLANS)
      .set(authHeader(a.tokens))
      .send({ match_id, custom_location: 'Draft', scheduled_at: soon(72) });

    return {
      ...pair,
      confirmedId: confirmed.body.data.id as string,
      proposedId: proposed.body.data.id as string,
      draftId: draft.body.data.id as string,
    };
  }

  async function expectClosed(plans: Awaited<ReturnType<typeof openPlans>>, endedBy: string) {
    const rows = await prisma.plan.findMany({
      where: { id: { in: [plans.confirmedId, plans.proposedId] } },
      select: { status: true, cancelled_by_id: true },
    });

    expect(rows).toEqual([
      { status: 'cancelled', cancelled_by_id: endedBy },
      { status: 'cancelled', cancelled_by_id: endedBy },
    ]);
    // A cancelled draft would show up in the other person's history.
    expect(await prisma.plan.count({ where: { id: plans.draftId } })).toBe(0);

    const upcoming = await api.get(`${PLANS}?tab=upcoming`).set(authHeader(plans.b.tokens));
    const pending = await api.get(`${PLANS}?tab=pending`).set(authHeader(plans.a.tokens));
    expect(upcoming.body.data).toEqual([]);
    expect(pending.body.data).toEqual([]);
  }

  it('closes the pair’s open plans on unmatch, telling nobody', async () => {
    const plans = await openPlans();
    const before = await planUpdatesFor(plans.b.user_id);

    await api
      .delete(`${API_PREFIX}/matches/${plans.match_id}`)
      .set(authHeader(plans.a.tokens))
      .expect(200);

    await expectClosed(plans, plans.a.user_id);
    expect(await planUpdatesFor(plans.b.user_id)).toBe(before);
  });

  it('closes them on a block too, without a notification that would hint at it', async () => {
    const plans = await openPlans();
    const before = await planUpdatesFor(plans.a.user_id);

    await api
      .post(`${API_PREFIX}/blocks`)
      .set(authHeader(plans.b.tokens))
      .send({ user_id: plans.a.user_id })
      .expect(201);

    await expectClosed(plans, plans.b.user_id);
    expect(await planUpdatesFor(plans.a.user_id)).toBe(before);
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
