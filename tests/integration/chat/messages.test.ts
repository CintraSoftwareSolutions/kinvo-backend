import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';
import { resetQuotas } from '@modules/entitlements/quota.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { LONDON, createBlock } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import {
  connectRedis,
  disconnectRedis,
  seedEntitlements,
  setFlag,
  setTier,
} from '../../helpers/entitlements';
import { matchPair, sendText } from '../../helpers/chat';

/**
 * Conversations and messages (spec §5.4, Batch 8).
 *
 * Messages are the one list in this API that paginates BACKWARDS — newest
 * first, the cursor walking into history — because a chat opens at the bottom.
 */

const CONV = `${API_PREFIX}/conversations`;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('conversation creation', () => {
  it('creates a conversation with the match, inheriting its mode', async () => {
    const { conversation_id, a } = await matchPair(Mode.study_buddy);

    const response = await api.get(`${CONV}/${conversation_id}`).set(authHeader(a.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.mode).toBe('study_buddy');
  });

  it('gives the conversation exactly two participants (decision #11)', async () => {
    const { conversation_id } = await matchPair(Mode.dating);

    const states = await prisma.conversationState.count({
      where: { conversation_id },
    });

    expect(states).toBe(2);
  });

  it('has no endpoint that creates one — messaging requires a match (decision #5)', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.post(CONV).set(authHeader(viewer.tokens)).send({});

    expect(response.status).toBe(404);
  });
});

describe('POST /conversations/:id/messages', () => {
  it('sends a text message', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await sendText(a, conversation_id, 'Hello there');

    expect(response.status).toBe(201);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.body).toBe('Hello there');
    expect(response.body.data.type).toBe('text');
    expect(response.body.data.sender_id).toBe(a.user_id);
    expect(response.body.data.read_at).toBeNull();
    expect(response.body.data.created_at).toMatch(/Z$/);
  });

  it('rejects an empty text message', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('rejects a media message with no upload', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'image' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('rejects a venue card with no venue', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'venue_card' });

    expect(response.status).toBe(400);
  });

  it('refuses an upload the sender does not own', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    const asset = await prisma.mediaAsset.create({
      data: {
        owner_id: b.user_id,
        kind: 'chat_image',
        s3_bucket: 'media',
        s3_key: 'chat/not-yours.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
        uploaded_at: new Date(),
      },
    });

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'image', media_asset_id: asset.id });

    expect(response.status).toBe(404);
  });

  it('refuses an upload that never finished', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const asset = await prisma.mediaAsset.create({
      data: {
        owner_id: a.user_id,
        kind: 'chat_image',
        s3_bucket: 'media',
        s3_key: 'chat/incomplete.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
        // No uploaded_at: an intent, not an asset.
        uploaded_at: null,
      },
    });

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'image', media_asset_id: asset.id });

    expect(response.status).toBe(400);
  });

  it('refuses to promote a verification document into a chat image', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const asset = await prisma.mediaAsset.create({
      data: {
        owner_id: a.user_id,
        kind: 'verification_document',
        s3_bucket: 'verification',
        s3_key: 'verification/id.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
        uploaded_at: new Date(),
      },
    });

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'image', media_asset_id: asset.id });

    // A government ID must never become a chat attachment.
    expect(response.status).toBe(404);
  });

  it('records a moderation override so the team can see it later', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'send me your wallet seed', moderation_overridden: true });

    // spec §5.4: a user pushing past a scam warning is exactly what the
    // moderation team needs to see.
    expect(response.body.data.moderation_overridden).toBe(true);
  });

  it('404s for someone who is not in the conversation', async () => {
    const { conversation_id } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(stranger.tokens))
      .send({ type: 'text', body: 'let me in' });

    expect(response.status).toBe(404);
  });

  it('requires a token', async () => {
    const { conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .post(`${CONV}/${conversation_id}/messages`)
      .send({ type: 'text', body: 'hi' });

    expect(response.status).toBe(401);
  });
});

describe('when a conversation is closed', () => {
  it('refuses a send to a blocked pair, but keeps history readable', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await sendText(a, conversation_id, 'before the block');

    await createBlock(b.user_id, a.user_id);

    const send = await sendText(a, conversation_id, 'after the block');
    const history = await api.get(`${CONV}/${conversation_id}/messages`).set(authHeader(a.tokens));

    expect(send.status).toBe(403);
    expectErrorEnvelope(send.body, 'FORBIDDEN');
    // History stays: hiding it makes the thread vanish and read as data loss.
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
  });

  it('gives the same error whichever side blocked, so nothing leaks', async () => {
    const first = await matchPair(Mode.dating);
    await createBlock(first.a.user_id, first.b.user_id);

    const second = await matchPair(Mode.dating);
    await createBlock(second.b.user_id, second.a.user_id);

    const blocker = await sendText(first.a, first.conversation_id, 'x');
    const blocked = await sendText(second.a, second.conversation_id, 'x');

    // "They blocked you" and "you blocked them" must be indistinguishable, or
    // a block is confirmable by elimination.
    expect(blocker.status).toBe(blocked.status);
    expect(blocker.body.error.code).toBe(blocked.body.error.code);
    expect(blocker.body.error.message).toBe(blocked.body.error.message);
  });

  it('refuses a send on an expired match with the SAME error as a block', async () => {
    const { a, match_id, conversation_id } = await matchPair(Mode.dating);

    await prisma.match.update({
      where: { id: match_id },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const response = await sendText(a, conversation_id, 'still there?');

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'FORBIDDEN');
  });

  it('refuses a send after an unmatch', async () => {
    const { a, b, match_id, conversation_id } = await matchPair(Mode.dating);

    await api.delete(`${API_PREFIX}/matches/${match_id}`).set(authHeader(b.tokens));

    const response = await sendText(a, conversation_id, 'hello?');

    expect(response.status).toBe(403);
  });

  it('refuses a send when the other person deleted their account', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    await prisma.user.update({ where: { id: b.user_id }, data: { deleted_at: new Date() } });

    const response = await sendText(a, conversation_id, 'hello?');

    expect(response.status).toBe(403);
  });
});

describe('GET /conversations/:id/messages', () => {
  it('paginates BACKWARDS — newest first (spec §4.5)', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    await sendText(a, conversation_id, 'first');
    await sendText(a, conversation_id, 'second');
    await sendText(a, conversation_id, 'third');

    const response = await api.get(`${CONV}/${conversation_id}/messages`).set(authHeader(a.tokens));

    expect(response.body.data.map((m: { body: string }) => m.body)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('walks the cursor into history without repeating a message', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    for (let i = 0; i < 5; i += 1) {
      await sendText(a, conversation_id, `message ${i}`);
    }

    const first = await api
      .get(`${CONV}/${conversation_id}/messages?limit=2`)
      .set(authHeader(a.tokens));

    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.pagination.has_more).toBe(true);

    const second = await api
      .get(
        `${CONV}/${conversation_id}/messages?limit=2&cursor=${first.body.meta.pagination.next_cursor}`,
      )
      .set(authHeader(a.tokens));

    const firstIds = first.body.data.map((m: { id: string }) => m.id);
    const secondIds = second.body.data.map((m: { id: string }) => m.id);

    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
    // Walking into the past: the second page is older than the first.
    expect(new Date(second.body.data[0].created_at).getTime()).toBeLessThanOrEqual(
      new Date(first.body.data[1].created_at).getTime(),
    );
  });

  it('404s for someone who is not in the conversation', async () => {
    const { conversation_id } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .get(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
  });

  it('returns an empty array for a conversation with nothing said yet', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api.get(`${CONV}/${conversation_id}/messages`).set(authHeader(a.tokens));

    expect(response.body.data).toEqual([]);
  });
});

describe('unread counts and read receipts', () => {
  it('raises the recipient badge, not the sender’s', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    await sendText(a, conversation_id, 'hello');

    const forSender = await api.get(`${CONV}/${conversation_id}`).set(authHeader(a.tokens));
    const forRecipient = await api.get(`${CONV}/${conversation_id}`).set(authHeader(b.tokens));

    expect(forSender.body.data.unread_count).toBe(0);
    expect(forRecipient.body.data.unread_count).toBe(1);
  });

  it('clears the badge on read', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await sendText(a, conversation_id, 'hello');

    const read = await api.post(`${CONV}/${conversation_id}/read`).set(authHeader(b.tokens));

    expect(read.status).toBe(200);
    expect(read.body.data.unread_count).toBe(0);

    const after = await api.get(`${CONV}/${conversation_id}`).set(authHeader(b.tokens));
    expect(after.body.data.unread_count).toBe(0);
  });

  it('stamps read_at on the other person’s messages only', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await sendText(a, conversation_id, 'from a');
    await sendText(b, conversation_id, 'from b');

    await api.post(`${CONV}/${conversation_id}/read`).set(authHeader(b.tokens));

    const messages = await prisma.message.findMany({ orderBy: { created_at: 'asc' } });

    // Marking your own message read would show the wrong tick to the sender.
    expect(messages[0]?.read_at).not.toBeNull();
    expect(messages[1]?.read_at).toBeNull();
  });

  it('sums unread across conversations for the app badge', async () => {
    const first = await matchPair(Mode.dating);
    await sendText(first.a, first.conversation_id, 'one');
    await sendText(first.a, first.conversation_id, 'two');

    const response = await api.get(`${CONV}/unread-count`).set(authHeader(first.b.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.unread_count).toBe(2);
  });

  it('does not read /unread-count as a conversation id', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(`${CONV}/unread-count`).set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.unread_count).toBe(0);
  });
});

describe('archive and mute', () => {
  it('archives for the caller only, and un-archives on a new message', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    await api
      .patch(`${CONV}/${conversation_id}`)
      .set(authHeader(b.tokens))
      .send({ is_archived: true });

    const archived = await api.get(`${CONV}?archived=true`).set(authHeader(b.tokens));
    expect(archived.body.data).toHaveLength(1);

    await sendText(a, conversation_id, 'still here');

    const active = await api.get(CONV).set(authHeader(b.tokens));
    // A new message pulls the thread back out of the archive; otherwise it is
    // silently unreachable while the badge counts up.
    expect(active.body.data).toHaveLength(1);
  });

  it('mutes without hiding', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .patch(`${CONV}/${conversation_id}`)
      .set(authHeader(a.tokens))
      .send({ is_muted: true });

    expect(response.body.data.is_muted).toBe(true);
    expect(response.body.data.is_archived).toBe(false);
  });

  it('rejects an empty update', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .patch(`${CONV}/${conversation_id}`)
      .set(authHeader(a.tokens))
      .send({});

    expect(response.status).toBe(400);
  });

  it('404s for someone who is not in the conversation', async () => {
    const { conversation_id } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .patch(`${CONV}/${conversation_id}`)
      .set(authHeader(stranger.tokens))
      .send({ is_archived: true });

    expect(response.status).toBe(404);
  });
});

describe('the daily message cap (spec §5.4)', () => {
  it('returns 422 QUOTA_EXCEEDED with paywall context, never 429', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_MESSAGE_LIMIT, 1);
    await resetQuotas(a.user_id);

    await sendText(a, conversation_id, 'first');
    const response = await sendText(a, conversation_id, 'second');

    expect(response.status).toBe(422);
    expectErrorEnvelope(response.body, 'QUOTA_EXCEEDED');
    expect(response.body.error.details).toMatchObject({
      quota: 'messages',
      limit: 1,
      upgrade_available: true,
    });
  });

  it('does not cap a paid tier', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);
    await setTier(a.user_id, 'advanced');
    await resetQuotas(a.user_id);

    for (let i = 0; i < 3; i += 1) {
      const response = await sendText(a, conversation_id, `message ${i}`);
      expect(response.status).toBe(201);
    }
  });

  it('does not charge for a message the database rejected', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await setFlag('free', ENTITLEMENT_KEYS.DAILY_MESSAGE_LIMIT, 3);
    await resetQuotas(a.user_id);

    await sendText(a, conversation_id, 'one');

    // Blocked: the send is refused before quota is even consumed.
    await createBlock(b.user_id, a.user_id);
    await sendText(a, conversation_id, 'two');

    const entitlements = await api.get(`${API_PREFIX}/me/entitlements`).set(authHeader(a.tokens));

    expect(entitlements.body.data.quotas.messages.used).toBe(1);
  });
});

describe('GET /conversations', () => {
  it('orders by activity, newest first', async () => {
    const first = await matchPair(Mode.dating);
    const second = await matchPair(Mode.dating, [], {
      a: first.a,
      b: await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON }),
    });

    await sendText(first.a, first.conversation_id, 'older');
    await sendText(first.a, second.conversation_id, 'newer');

    const response = await api.get(CONV).set(authHeader(first.a.tokens));

    expect(response.body.data[0].id).toBe(second.conversation_id);
  });

  it('carries the header without a second call (spec §4.7)', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await sendText(b, conversation_id, 'hi there');

    const response = await api.get(CONV).set(authHeader(a.tokens));

    const conversation = response.body.data[0];
    expect(conversation.user.id).toBe(b.user_id);
    expect(conversation.user.display_name).toBe('Blake');
    expect(conversation.last_message_preview).toBe('hi there');
    expect(conversation.unread_count).toBe(1);
    expect(conversation.mode).toBe('dating');
  });

  it('previews media without leaking a URL into the list', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const asset = await prisma.mediaAsset.create({
      data: {
        owner_id: a.user_id,
        kind: 'chat_image',
        s3_bucket: 'media',
        s3_key: 'chat/photo.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 2048,
        uploaded_at: new Date(),
      },
    });

    await api
      .post(`${CONV}/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'image', media_asset_id: asset.id });

    const response = await api.get(CONV).set(authHeader(a.tokens));

    expect(response.body.data[0].last_message_preview).toBe('Photo');
    expect(JSON.stringify(response.body)).not.toContain('chat/photo.jpg');
  });

  it('drops a conversation whose match was unmatched', async () => {
    const { a, match_id } = await matchPair(Mode.dating);

    await api.delete(`${API_PREFIX}/matches/${match_id}`).set(authHeader(a.tokens));

    const response = await api.get(CONV).set(authHeader(a.tokens));

    expect(response.body.data).toEqual([]);
  });

  it('requires a token', async () => {
    const response = await api.get(CONV);

    expect(response.status).toBe(401);
  });
});
