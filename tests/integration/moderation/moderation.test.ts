import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import {
  resetModerationProvider,
  setModerationProvider,
} from '@modules/moderation/moderation.service';
import { UnavailableModerationProvider } from '@/providers/rules-moderation.provider';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { addPhoto } from '../../helpers/media';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair, sendText } from '../../helpers/chat';

/**
 * Moderation (spec §5.4, Batch 10).
 *
 * The two properties this suite exists to protect:
 *
 *  - The check is ADVISORY. It never refuses a send, in any circumstance.
 *  - It FAILS OPEN. A provider outage lets the message through and queues it,
 *    because blocking a user's message on a third party is a worse failure than
 *    reviewing it late.
 */

const CHECK = `${API_PREFIX}/moderation/check`;
const FLAGS = `${API_PREFIX}/moderation/flags`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
  resetModerationProvider();
});

afterAll(async () => {
  resetModerationProvider();
  await closeDatabase();
  await disconnectRedis();
});

describe('POST /moderation/check', () => {
  it('passes ordinary text with no warning', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'Hey, how was your weekend?', subject_type: 'message' });

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.severity).toBe('none');
    expect(response.body.data.should_warn).toBe(false);
    expect(response.body.data.findings).toEqual([]);
    expect(response.body.data.can_send).toBe(true);
  });

  it('warns on scam language and still permits the send', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message' });

    expect(response.body.data.severity).toBe('critical');
    expect(response.body.data.should_warn).toBe(true);
    // spec §5.4: advisory, not blocking — even at the highest severity.
    expect(response.body.data.can_send).toBe(true);
    expect(response.body.data.findings[0].category).toBe('scam_payment');
    expect(response.body.data.findings[0].message.length).toBeGreaterThan(0);
  });

  it('never refuses a send, at any severity', async () => {
    const { tokens } = await createAuthenticatedUser();

    const worst = [
      'send me your private key',
      'i know where you live',
      'im 15',
      'wire me the money via western union',
    ];

    for (const content of worst) {
      const response = await api
        .post(CHECK)
        .set(authHeader(tokens))
        .send({ content, subject_type: 'message' });

      expect(response.status).toBe(200);
      expect(response.body.data.can_send).toBe(true);
    }
  });

  it('records the check without storing the content', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();

    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'my secret draft about cash app', subject_type: 'message' });

    const record = await prisma.moderationCheck.findFirstOrThrow({
      where: { user_id },
    });

    // A copy of every message a user considered sending — including the ones
    // they thought better of — is a surveillance database nobody asked for.
    expect(record.content_hash).toHaveLength(64);
    expect(JSON.stringify(record)).not.toContain('secret draft');
  });

  it('records an override, which is what the moderation team needs later', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();

    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message', overridden: true });

    const record = await prisma.moderationCheck.findFirstOrThrow({ where: { user_id } });

    expect(record.was_overridden).toBe(true);
  });

  it('checks a bio, not just messages', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'DM me on telegram for signals', subject_type: 'bio' });

    expect(response.body.data.should_warn).toBe(true);
  });

  it('rejects an empty payload', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.post(CHECK).set(authHeader(tokens)).send({ content: '' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('requires a token', async () => {
    const response = await api.post(CHECK).send({ content: 'hello' });

    expect(response.status).toBe(401);
  });
});

describe('scam checks are global, never dating-scoped (spec §1)', () => {
  it('warns identically in trading and in dating', async () => {
    const { tokens } = await createAuthenticatedUser();
    const pitch = 'guaranteed returns, join my signal group';

    // The check takes no mode at all, which is the strongest form of "not
    // dating-scoped": it cannot be scoped by mistake. Trading is where
    // investment fraud will actually live.
    const first = await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: pitch, subject_type: 'message' });

    const second = await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: pitch, subject_type: 'bio' });

    expect(first.body.data.severity).toBe(second.body.data.severity);
    expect(first.body.data.severity).toBe('high');
  });
});

describe('failing open (spec §5.4)', () => {
  it('allows the send when the provider is unreachable', async () => {
    const { tokens } = await createAuthenticatedUser();
    setModerationProvider(new UnavailableModerationProvider());

    const response = await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message' });

    // Never block a user's message on a third-party outage.
    expect(response.status).toBe(200);
    expect(response.body.data.can_send).toBe(true);
    expect(response.body.data.timed_out).toBe(true);
    expect(response.body.data.severity).toBe('none');
  });

  it('records that nothing was actually checked', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    setModerationProvider(new UnavailableModerationProvider());

    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'anything', subject_type: 'message' });

    const record = await prisma.moderationCheck.findFirstOrThrow({ where: { user_id } });

    // Otherwise an outage looks identical to a clean sweep.
    expect(record.timed_out).toBe(true);
  });
});

describe('the moderation queue', () => {
  it('queues content at or above the flag threshold', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message' });

    const flags = await prisma.moderationFlag.findMany();

    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe('critical');
    expect(flags[0]?.status).toBe('open');
  });

  it('does not queue low-severity findings', async () => {
    const { tokens } = await createAuthenticatedUser();

    // Sharing a phone number is worth a warning, not a moderator's time.
    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'call me on 555 123 4567', subject_type: 'message' });

    expect(await prisma.moderationFlag.count()).toBe(0);
  });

  it('does not queue the same subject twice', async () => {
    const { tokens } = await createAuthenticatedUser();
    const subjectId = '00000000-0000-4000-8000-0000000000aa';

    for (let i = 0; i < 3; i += 1) {
      await api.post(CHECK).set(authHeader(tokens)).send({
        content: 'send me your seed phrase',
        subject_type: 'message',
        subject_id: subjectId,
      });
    }

    expect(await prisma.moderationFlag.count()).toBe(1);
  });

  it('raises severity on re-scan but never lowers it', async () => {
    const { tokens } = await createAuthenticatedUser();
    const subjectId = '00000000-0000-4000-8000-0000000000bb';

    await api.post(CHECK).set(authHeader(tokens)).send({
      content: 'do you have cash app',
      subject_type: 'message',
      subject_id: subjectId,
    });

    expect((await prisma.moderationFlag.findFirstOrThrow()).severity).toBe('medium');

    await api.post(CHECK).set(authHeader(tokens)).send({
      content: 'send me your seed phrase',
      subject_type: 'message',
      subject_id: subjectId,
    });

    expect((await prisma.moderationFlag.findFirstOrThrow()).severity).toBe('critical');

    // A later benign scan must not quiet an earlier serious finding.
    await api.post(CHECK).set(authHeader(tokens)).send({
      content: 'do you have cash app',
      subject_type: 'message',
      subject_id: subjectId,
    });

    expect((await prisma.moderationFlag.findFirstOrThrow()).severity).toBe('critical');
  });
});

describe('post-hoc scanning', () => {
  it('flags a sent message the client never pre-checked', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    // The pre-send check is offered, not required. Whatever the client does,
    // what was actually sent gets scanned.
    const response = await sendText(a, conversation_id, 'send me your seed phrase');

    expect(response.status).toBe(201);

    const message = await prisma.message.findFirstOrThrow();
    expect(message.moderation_flagged).toBe(true);

    const flags = await prisma.moderationFlag.findMany({ where: { subject_type: 'message' } });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.subject_id).toBe(message.id);
  });

  it('leaves an ordinary message unflagged', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    await sendText(a, conversation_id, 'how was your weekend?');

    const message = await prisma.message.findFirstOrThrow();
    expect(message.moderation_flagged).toBe(false);
    expect(await prisma.moderationFlag.count()).toBe(0);
  });

  it('still delivers the message when the provider is down', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);
    setModerationProvider(new UnavailableModerationProvider());

    const response = await sendText(a, conversation_id, 'send me your seed phrase');

    // Fail open all the way through: an outage costs a review, not a message.
    expect(response.status).toBe(201);
    expect(await prisma.message.count()).toBe(1);
  });

  it('queues a photo for a human, because rules cannot read pixels', async () => {
    const { tokens } = await createAuthenticatedUser();

    // Goes through the real two-step upload handshake, so this exercises the
    // path a client actually takes rather than a hand-built row.
    const photo = await addPhoto(tokens);

    // The photo is live immediately (spec §7 asks for a POST-HOC queue, not a
    // gate) — nobody could finish onboarding if every photo waited for a
    // moderator to be awake.
    expect(photo.moderation_status).toBe('approved');

    // A queue that looks healthy while nothing is being checked is worse than
    // no queue, so the gap rules-based v1 has with images is made visible
    // rather than marked clean.
    const flags = await prisma.moderationFlag.findMany({ where: { subject_type: 'photo' } });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.subject_id).toBe(photo.id);
    expect(flags[0]?.reason).toMatch(/human review/i);
  });
});

describe('GET /moderation/flags', () => {
  async function seedFlag() {
    const { tokens } = await createAuthenticatedUser();
    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message' });
  }

  it('is refused for an ordinary user', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(FLAGS).set(authHeader(tokens));

    // 403, not 404: an admin surface is documented and there is nothing to
    // conceal about its existence — unlike a block (spec §4.4).
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'FORBIDDEN');
  });

  it('lists the queue for a moderator', async () => {
    await seedFlag();
    const moderator = await createAuthenticatedUser({ role: 'moderator' });

    const response = await api.get(FLAGS).set(authHeader(moderator.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].severity).toBe('critical');
    expect(response.body.data[0].created_at).toMatch(/Z$/);
  });

  it('filters by status and severity', async () => {
    await seedFlag();
    const moderator = await createAuthenticatedUser({ role: 'admin' });

    const open = await api.get(`${FLAGS}?status=open`).set(authHeader(moderator.tokens));
    const dismissed = await api.get(`${FLAGS}?status=dismissed`).set(authHeader(moderator.tokens));
    const low = await api.get(`${FLAGS}?severity=low`).set(authHeader(moderator.tokens));

    expect(open.body.data).toHaveLength(1);
    expect(dismissed.body.data).toEqual([]);
    expect(low.body.data).toEqual([]);
  });

  it('requires a token', async () => {
    const response = await api.get(FLAGS);

    expect(response.status).toBe(401);
  });
});

describe('PATCH /moderation/flags/:id', () => {
  it('resolves a flag and records who did it', async () => {
    const { tokens } = await createAuthenticatedUser();
    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message' });

    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const flag = await prisma.moderationFlag.findFirstOrThrow();

    const response = await api
      .patch(`${FLAGS}/${flag.id}`)
      .set(authHeader(moderator.tokens))
      .send({ status: 'actioned' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('actioned');
    expect(response.body.data.assigned_to_id).toBe(moderator.user_id);
    expect(response.body.data.resolved_at).not.toBeNull();
  });

  it('leaves resolved_at null while still under review', async () => {
    const { tokens } = await createAuthenticatedUser();
    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message' });

    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const flag = await prisma.moderationFlag.findFirstOrThrow();

    const response = await api
      .patch(`${FLAGS}/${flag.id}`)
      .set(authHeader(moderator.tokens))
      .send({ status: 'under_review' });

    expect(response.body.data.resolved_at).toBeNull();
  });

  it('is refused for an ordinary user', async () => {
    const { tokens } = await createAuthenticatedUser();
    await api
      .post(CHECK)
      .set(authHeader(tokens))
      .send({ content: 'send me your seed phrase', subject_type: 'message' });

    const flag = await prisma.moderationFlag.findFirstOrThrow();

    const response = await api
      .patch(`${FLAGS}/${flag.id}`)
      .set(authHeader(tokens))
      .send({ status: 'dismissed' });

    expect(response.status).toBe(403);
    expect((await prisma.moderationFlag.findFirstOrThrow()).status).toBe('open');
  });

  it('404s for a flag that does not exist', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });

    const response = await api
      .patch(`${FLAGS}/00000000-0000-4000-8000-000000000000`)
      .set(authHeader(moderator.tokens))
      .send({ status: 'dismissed' });

    expect(response.status).toBe(404);
  });

  it('rejects a status outside the allowed set', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });

    const response = await api
      .patch(`${FLAGS}/00000000-0000-4000-8000-000000000000`)
      .set(authHeader(moderator.tokens))
      .send({ status: 'open' });

    expect(response.status).toBe(400);
  });
});
