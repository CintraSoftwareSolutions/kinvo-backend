import { API_PREFIX } from '@config/constants';
import { CallStatus, MatchStatus, Mode, prisma } from '@/db/prisma';
import { VIDEO_TOKEN_TTL_SECONDS } from '@/providers/video.provider';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair } from '../../helpers/chat';

/**
 * Video calling (spec §5.7, §7, Batch 14).
 *
 * The rule worth most of these tests, quoted from the spec:
 *
 *   "Tokens must be short-lived and scoped to a specific room. Never issue a
 *    token that grants access to arbitrary rooms."
 *
 * A leak here is not a data leak — it is a stranger appearing on someone's
 * camera. So the permission boundary is tested from both sides, and the token's
 * room is asserted to match the call's room rather than assumed to.
 */

const CALLS = `${API_PREFIX}/calls`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('POST /calls', () => {
  it('starts a call and returns a token scoped to that call’s room', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    const response = await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });

    expectSuccessEnvelope(response.body);
    expect(response.status).toBe(201);

    const call = response.body.data.call;
    expect(call.status).toBe('ringing');
    expect(call.is_initiator).toBe(true);
    expect(call.match_id).toBe(match_id);
    expect(call.mode).toBe('dating');

    // The room the client is told to join must be the room stored on the call.
    // Deriving those from two different values is how a token silently admits
    // its holder somewhere the app is not.
    const row = await prisma.callSession.findUniqueOrThrow({ where: { id: call.id } });
    expect(call.video.room_name).toBe(row.room_name);
    expect(call.video.token).toBeTruthy();

    // Short-lived, per the spec. Asserted as a bound rather than an exact value
    // so the constant can move without rewriting the test.
    const ttlMs = new Date(call.video.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(VIDEO_TOKEN_TTL_SECONDS * 1000 + 5_000);
  });

  it('rejects a body naming anything other than a match', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    // A room name from the client is the exact hole the spec warns about.
    const response = await api
      .post(CALLS)
      .set(authHeader(a.tokens))
      .send({ match_id, room_name: 'kinvo-call-somebody-elses' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('404s for a match the caller is not in', async () => {
    const { match_id } = await matchPair(Mode.dating);
    const outsider = await matchPair(Mode.foodie);

    const response = await api.post(CALLS).set(authHeader(outsider.a.tokens)).send({ match_id });

    // 404, not 403 — a 403 confirms the match id is real (spec §4.4).
    expect(response.status).toBe(404);
  });

  it('returns the SAME call when one is already live, rather than a second room', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const first = await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });
    const second = await api.post(CALLS).set(authHeader(b.tokens)).send({ match_id });

    expect(second.body.data.call.id).toBe(first.body.data.call.id);
    expect(second.body.data.call.video.room_name).toBe(first.body.data.call.video.room_name);

    expect(await prisma.callSession.count({ where: { match_id } })).toBe(1);
  });

  it('notifies the other person, in the feed as well as by push', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });

    // spec §7: persisted to the feed AND pushed, never pushed alone — a
    // push-only call would vanish from the app when the banner is dismissed,
    // and a missed call has to be visible afterwards.
    const notification = await prisma.notification.findFirst({
      where: { user_id: b.user_id, category: 'call' },
    });

    expect(notification).not.toBeNull();
    // It must not name who is calling in a way that leaks more than the app
    // already shows.
    expect(notification!.title).toBe('Incoming call');
  });
});

describe('the permission boundary is the whole feature', () => {
  it('refuses once the pair is blocked', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    await api.post(`${API_PREFIX}/blocks`).set(authHeader(b.tokens)).send({ user_id: a.user_id });

    const response = await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });

    expect(response.status).toBe(404);
  });

  it('refuses after unmatching', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    await prisma.match.update({
      where: { id: match_id },
      data: { status: MatchStatus.unmatched, unmatched_at: new Date() },
    });

    const response = await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });

    expect(response.status).toBe(404);
  });

  it('refuses once the match has expired', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    await prisma.match.update({
      where: { id: match_id },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    // Expiry is read-time, so this holds whether or not the sweep has run.
    const response = await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });

    expect(response.status).toBe(404);
  });

  it('answers every refusal identically, so a block cannot be identified', async () => {
    const blocked = await matchPair(Mode.dating);
    await api
      .post(`${API_PREFIX}/blocks`)
      .set(authHeader(blocked.b.tokens))
      .send({ user_id: blocked.a.user_id });

    const unmatched = await matchPair(Mode.foodie);
    await prisma.match.update({
      where: { id: unmatched.match_id },
      data: { status: MatchStatus.unmatched },
    });

    const first = await api
      .post(CALLS)
      .set(authHeader(blocked.a.tokens))
      .send({ match_id: blocked.match_id });
    const second = await api
      .post(CALLS)
      .set(authHeader(unmatched.a.tokens))
      .send({ match_id: unmatched.match_id });

    // Byte-identical. "They blocked you" and "you unmatched" are different
    // facts, and distinguishing them confirms a block by elimination.
    expect(first.status).toBe(second.status);
    expect(first.body.error.code).toBe(second.body.error.code);
    expect(first.body.error.message).toBe(second.body.error.message);
  });

  it('stops the next reconnect when a block lands mid-call', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);

    const started = await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });
    const callId = started.body.data.call.id;

    await api.post(`${CALLS}/${callId}/answer`).set(authHeader(b.tokens));

    await api.post(`${API_PREFIX}/blocks`).set(authHeader(b.tokens)).send({ user_id: a.user_id });

    // Blocking someone who is on your screen has to do something before they
    // hang up, and the token endpoint is the next thing their client calls.
    const response = await api.get(`${CALLS}/${callId}/token`).set(authHeader(a.tokens));

    expect(response.status).toBe(404);
  });

  it('never issues a token to someone outside the call', async () => {
    const { a, match_id } = await matchPair(Mode.dating);
    const outsider = await matchPair(Mode.foodie);

    const started = await api.post(CALLS).set(authHeader(a.tokens)).send({ match_id });
    const callId = started.body.data.call.id;

    const response = await api.get(`${CALLS}/${callId}/token`).set(authHeader(outsider.a.tokens));

    expect(response.status).toBe(404);
  });
});

describe('the lifecycle', () => {
  async function start(mode: Mode = Mode.dating) {
    const pair = await matchPair(mode);
    const response = await api
      .post(CALLS)
      .set(authHeader(pair.a.tokens))
      .send({ match_id: pair.match_id });

    return { ...pair, call_id: response.body.data.call.id as string };
  }

  it('lets the callee answer, and gives them a token for the same room', async () => {
    const { a, b, call_id } = await start();

    const response = await api.post(`${CALLS}/${call_id}/answer`).set(authHeader(b.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.call.status).toBe('active');
    expect(response.body.data.call.is_initiator).toBe(false);

    const row = await prisma.callSession.findUniqueOrThrow({ where: { id: call_id } });
    expect(response.body.data.call.video.room_name).toBe(row.room_name);
    expect(row.answered_at).not.toBeNull();

    // Both sides hold a token for one room. Different tokens, same room.
    const callerToken = await api.get(`${CALLS}/${call_id}/token`).set(authHeader(a.tokens));
    expect(callerToken.body.data.call.video.room_name).toBe(row.room_name);
  });

  it('refuses to let the initiator answer their own call', async () => {
    const { a, call_id } = await start();

    const response = await api.post(`${CALLS}/${call_id}/answer`).set(authHeader(a.tokens));

    expect(response.status).toBe(403);
  });

  it('409s on answering a call that is no longer ringing', async () => {
    const { b, call_id } = await start();

    await api.post(`${CALLS}/${call_id}/decline`).set(authHeader(b.tokens));

    const response = await api.post(`${CALLS}/${call_id}/answer`).set(authHeader(b.tokens));

    expect(response.status).toBe(409);
  });

  it('records a decline distinctly from an end', async () => {
    const { b, call_id } = await start();

    const response = await api.post(`${CALLS}/${call_id}/decline`).set(authHeader(b.tokens));

    expect(response.body.data.call.status).toBe('declined');
  });

  it('measures duration from when the call was ANSWERED', async () => {
    const { a, b, call_id } = await start();

    await api.post(`${CALLS}/${call_id}/answer`).set(authHeader(b.tokens));

    // Backdate the answer so there is a measurable duration without sleeping.
    await prisma.callSession.update({
      where: { id: call_id },
      data: { answered_at: new Date(Date.now() - 30_000) },
    });

    const response = await api.post(`${CALLS}/${call_id}/end`).set(authHeader(a.tokens));

    expect(response.body.data.call.status).toBe('ended');
    // Thirty seconds of conversation, not the ringing time before it.
    expect(response.body.data.call.duration_seconds).toBeGreaterThanOrEqual(29);
    expect(response.body.data.call.duration_seconds).toBeLessThan(60);
  });

  it('is idempotent on hang-up, because both apps send it', async () => {
    const { a, b, call_id } = await start();

    await api.post(`${CALLS}/${call_id}/answer`).set(authHeader(b.tokens));

    const first = await api.post(`${CALLS}/${call_id}/end`).set(authHeader(a.tokens));
    const second = await api.post(`${CALLS}/${call_id}/end`).set(authHeader(b.tokens));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.call.status).toBe('ended');
  });

  it('records an unanswered call as missed, with no duration', async () => {
    const { a, call_id } = await start();

    const response = await api.post(`${CALLS}/${call_id}/end`).set(authHeader(a.tokens));

    expect(response.body.data.call.status).toBe('missed');
    // Null rather than 0 — zero would read as a call that connected silently.
    expect(response.body.data.call.duration_seconds).toBeNull();
  });

  it('refuses a token once the call is over', async () => {
    const { a, b, call_id } = await start();

    await api.post(`${CALLS}/${call_id}/answer`).set(authHeader(b.tokens));
    await api.post(`${CALLS}/${call_id}/end`).set(authHeader(a.tokens));

    // A token for a finished room is a credential with no purpose.
    const response = await api.get(`${CALLS}/${call_id}/token`).set(authHeader(a.tokens));

    expect(response.status).toBe(409);
  });

  it('reads a rung-out call as missed before any job has run', async () => {
    const { a, call_id } = await start();

    await prisma.callSession.update({
      where: { id: call_id },
      data: { created_at: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const response = await api.get(CALLS).set(authHeader(a.tokens));

    // The column still says ringing; the answer must not.
    const row = await prisma.callSession.findUniqueOrThrow({ where: { id: call_id } });
    expect(row.status).toBe(CallStatus.ringing);
    expect(response.body.data[0].status).toBe('missed');
  });

  it('refuses to answer a call that rang out', async () => {
    const { b, call_id } = await start();

    await prisma.callSession.update({
      where: { id: call_id },
      data: { created_at: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const response = await api.post(`${CALLS}/${call_id}/answer`).set(authHeader(b.tokens));

    expect(response.status).toBe(409);
  });
});

describe('GET /calls', () => {
  it('lists history newest first, with no token attached', async () => {
    const pair = await matchPair(Mode.dating);

    const first = await api
      .post(CALLS)
      .set(authHeader(pair.a.tokens))
      .send({ match_id: pair.match_id });
    await api.post(`${CALLS}/${first.body.data.call.id}/end`).set(authHeader(pair.a.tokens));

    const second = await api
      .post(CALLS)
      .set(authHeader(pair.a.tokens))
      .send({ match_id: pair.match_id });
    await api.post(`${CALLS}/${second.body.data.call.id}/end`).set(authHeader(pair.a.tokens));

    const response = await api.get(CALLS).set(authHeader(pair.a.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0].id).toBe(second.body.data.call.id);
    // History has nothing to join.
    expect(response.body.data[0].video).toBeUndefined();
    // spec §4.7: enough to render the row without a follow-up call per item.
    expect(response.body.data[0].other_user.display_name).toBeTruthy();
    expect(response.body.meta.pagination).toBeDefined();
  });

  it('shows a call to both participants and to nobody else', async () => {
    const pair = await matchPair(Mode.dating);
    const outsider = await matchPair(Mode.foodie);

    await api.post(CALLS).set(authHeader(pair.a.tokens)).send({ match_id: pair.match_id });

    const forB = await api.get(CALLS).set(authHeader(pair.b.tokens));
    const forOutsider = await api.get(CALLS).set(authHeader(outsider.b.tokens));

    expect(forB.body.data).toHaveLength(1);
    expect(forB.body.data[0].is_initiator).toBe(false);
    expect(forOutsider.body.data).toHaveLength(0);
  });

  it('scopes a call to the mode its match belongs to', async () => {
    const pair = await matchPair(Mode.dating, [Mode.foodie]);

    await api.post(CALLS).set(authHeader(pair.a.tokens)).send({ match_id: pair.match_id });

    const response = await api.get(CALLS).set(authHeader(pair.a.tokens));

    // A call inherits its match's mode and cannot drift to another.
    expect(response.body.data[0].mode).toBe('dating');
  });
});

describe('in-call safety actions (spec §5.7)', () => {
  async function startAnswered() {
    const pair = await matchPair(Mode.dating);
    const started = await api
      .post(CALLS)
      .set(authHeader(pair.a.tokens))
      .send({ match_id: pair.match_id });
    const callId = started.body.data.call.id as string;
    await api.post(`${CALLS}/${callId}/answer`).set(authHeader(pair.b.tokens));
    return { ...pair, call_id: callId };
  }

  it('records a flag without ending the call', async () => {
    const { b, call_id } = await startAnswered();

    const response = await api
      .post(`${CALLS}/${call_id}/safety`)
      .set(authHeader(b.tokens))
      .send({ action: 'flag' });

    expect(response.status).toBe(200);
    expect(response.body.data.call_status).toBe('active');

    const recorded = await prisma.callSafetyAction.findFirst({ where: { call_id } });
    expect(recorded!.action).toBe('flag');
  });

  it('ends the call AND files a report on end_and_report', async () => {
    const { a, b, call_id } = await startAnswered();

    const response = await api
      .post(`${CALLS}/${call_id}/safety`)
      .set(authHeader(b.tokens))
      .send({ action: 'end_and_report', note: 'Made me uncomfortable.' });

    expect(response.status).toBe(200);
    expect(response.body.data.call_status).toBe('ended');
    expect(response.body.data.report_id).not.toBeNull();

    const report = await prisma.report.findUniqueOrThrow({
      where: { id: response.body.data.report_id },
    });
    expect(report.reported_id).toBe(a.user_id);
    expect(report.reporter_id).toBe(b.user_id);
    expect(report.context_type).toBe('call');
    expect(report.context_id).toBe(call_id);
  });

  it('never tells the reported person who reported them', async () => {
    const { a, b, call_id } = await startAnswered();

    const before = await prisma.notification.count({ where: { user_id: a.user_id } });

    await api
      .post(`${CALLS}/${call_id}/safety`)
      .set(authHeader(b.tokens))
      .send({ action: 'end_and_report' });

    // spec §5.7: not through any endpoint, notification, or error message.
    //
    // Scoped to what the report CREATED, not to every notification the user
    // has. An earlier "It's a match" legitimately names the other person, and
    // asserting against the whole feed would fail on that while proving
    // nothing about the report.
    const after = await prisma.notification.findMany({
      where: { user_id: a.user_id },
      orderBy: { created_at: 'desc' },
      take: Math.max(
        0,
        (await prisma.notification.count({ where: { user_id: a.user_id } })) - before,
      ),
    });

    for (const notification of after) {
      expect(JSON.stringify(notification)).not.toContain(b.user_id);
      expect(notification.category).not.toBe('moderation');
    }

    // Nor through the call history, which is the other place the reported
    // person could go looking.
    const history = await api.get(CALLS).set(authHeader(a.tokens));
    expect(JSON.stringify(history.body)).not.toContain('report');

    // And the report itself is invisible to them.
    const theirReports = await api.get(`${API_PREFIX}/reports`).set(authHeader(a.tokens));
    expect(theirReports.body.data).toHaveLength(0);
  });

  it('accepts a safety action with no note', async () => {
    const { b, call_id } = await startAnswered();

    // Someone reaching for this mid-call is not in a position to write an
    // explanation; requiring one would fail at the moment it is most needed.
    const response = await api
      .post(`${CALLS}/${call_id}/safety`)
      .set(authHeader(b.tokens))
      .send({ action: 'send_live_update' });

    expect(response.status).toBe(200);
  });

  it('rejects an action outside the enum', async () => {
    const { b, call_id } = await startAnswered();

    const response = await api
      .post(`${CALLS}/${call_id}/safety`)
      .set(authHeader(b.tokens))
      .send({ action: 'call_the_police' });

    expect(response.status).toBe(400);
  });

  it('404s for a call the actor is not in', async () => {
    const { call_id } = await startAnswered();
    const outsider = await matchPair(Mode.foodie);

    const response = await api
      .post(`${CALLS}/${call_id}/safety`)
      .set(authHeader(outsider.a.tokens))
      .send({ action: 'flag' });

    expect(response.status).toBe(404);
  });
});

describe('auth and validation', () => {
  it('requires a token on every route', async () => {
    const responses = await Promise.all([
      api.get(CALLS),
      api.post(CALLS).send({ match_id: '00000000-0000-4000-8000-000000000000' }),
      api.get(`${CALLS}/00000000-0000-4000-8000-000000000000/token`),
      api.post(`${CALLS}/00000000-0000-4000-8000-000000000000/answer`),
      api.post(`${CALLS}/00000000-0000-4000-8000-000000000000/end`),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
    }
  });

  it('rejects a call id that is not a uuid', async () => {
    const { a } = await matchPair(Mode.dating);

    const response = await api.get(`${CALLS}/not-a-uuid/token`).set(authHeader(a.tokens));

    expect(response.status).toBe(400);
  });
});
