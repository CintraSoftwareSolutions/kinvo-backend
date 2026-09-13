import { API_PREFIX } from '@config/constants';
import { Mode, UserStatus, prisma } from '@/db/prisma';
import jwt from 'jsonwebtoken';

import { env } from '@config/env';
import { resetPresenceThrottle } from '@/realtime/presence';
import { SERVER_EVENTS } from '@/realtime/events';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { LONDON, createBlock } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair } from '../../helpers/chat';
import {
  connectClient,
  connectWithToken,
  disconnectClient,
  expectNoEvent,
  nextEvent,
  settle,
  startTestSocketServer,
  stopTestSocketServer,
} from '../../helpers/socket';

/**
 * Realtime (spec §7, Batch 9).
 *
 * A real Socket.IO server on an ephemeral port with real clients — the
 * handshake, room membership, and disconnect handling are exactly the parts a
 * mock would not exercise.
 *
 * The rule under test throughout: realtime is a DELIVERY layer, never a second
 * write path. Everything emitted here was persisted first.
 */

beforeAll(async () => {
  await connectRedis();
  await startTestSocketServer();
});

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
  resetPresenceThrottle();
});

afterAll(async () => {
  await stopTestSocketServer();
  await closeDatabase();
  await disconnectRedis();
});

describe('handshake authentication', () => {
  it('connects with a valid access token', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const client = await connectClient(viewer.tokens);

    expect(client.connected).toBe(true);
    await disconnectClient(client);
  });

  it('refuses a connection with no token', async () => {
    await expect(connectWithToken(undefined)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refuses a malformed token as INVALID, not expired', async () => {
    await expect(connectWithToken('not-a-jwt')).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('keeps EXPIRED distinct from INVALID', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    // Signed already-expired rather than moving the clock: mocking Date.now
    // around live socket I/O breaks the transport's own timers, the same trap
    // as fake timers with ioredis.
    //
    // The app refreshes and reconnects on EXPIRED but signs the user out on
    // INVALID, so collapsing the two turns every routine expiry into a
    // sign-out.
    const expired = jwt.sign({ sub: viewer.user_id, type: 'access' }, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: -10,
    });

    await expect(connectWithToken(expired)).rejects.toMatchObject({
      code: 'AUTH_TOKEN_EXPIRED',
    });
  });

  it('refuses a token for a deleted account', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await prisma.user.update({
      where: { id: viewer.user_id },
      data: { deleted_at: new Date() },
    });

    await expect(connectWithToken(viewer.tokens.access_token)).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('refuses a suspended account, loading state fresh rather than trusting the token', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    // The token was issued while the account was healthy. A socket lives for
    // hours, so suspension has to take effect on the next connect at the latest.
    await prisma.user.update({
      where: { id: viewer.user_id },
      data: { status: UserStatus.suspended },
    });

    await expect(connectWithToken(viewer.tokens.access_token)).rejects.toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  it('refuses an account that has not finished onboarding', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await prisma.user.update({
      where: { id: viewer.user_id },
      data: { onboarded_at: null },
    });

    await expect(connectWithToken(viewer.tokens.access_token)).rejects.toMatchObject({
      code: 'ONBOARDING_INCOMPLETE',
    });
  });
});

describe('message delivery', () => {
  it('delivers a message to the recipient', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    const recipient = await connectClient(b.tokens);

    const delivered = nextEvent<{ body: string; sender_id: string }>(
      recipient,
      SERVER_EVENTS.MESSAGE_NEW,
    );

    await api
      .post(`${API_PREFIX}/conversations/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'over the wire' });

    const payload = await delivered;

    expect(payload.body).toBe('over the wire');
    expect(payload.sender_id).toBe(a.user_id);

    await disconnectClient(recipient);
  });

  it('persists the message even when nobody is connected', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    const response = await api
      .post(`${API_PREFIX}/conversations/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'nobody listening' });

    // Persist first, then emit. The socket is delivery, never durability, so a
    // message sent to an offline user is still a message.
    expect(response.status).toBe(201);
    expect(await prisma.message.count()).toBe(1);
  });

  it('delivers to every device the recipient has open', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    const phone = await connectClient(b.tokens);
    const tablet = await connectClient(b.tokens);

    const onPhone = nextEvent(phone, SERVER_EVENTS.MESSAGE_NEW);
    const onTablet = nextEvent(tablet, SERVER_EVENTS.MESSAGE_NEW);

    await api
      .post(`${API_PREFIX}/conversations/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'both screens' });

    await expect(onPhone).resolves.toBeDefined();
    await expect(onTablet).resolves.toBeDefined();

    await disconnectClient(phone);
    await disconnectClient(tablet);
  });

  it('never delivers a message to someone outside the conversation', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const eavesdropper = await connectClient(stranger.tokens);

    const listening = expectNoEvent(eavesdropper, SERVER_EVENTS.MESSAGE_NEW);

    await api
      .post(`${API_PREFIX}/conversations/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'private' });

    await expect(listening).resolves.toBeUndefined();

    await disconnectClient(eavesdropper);
  });

  it('updates the conversation row so the badge moves without a refetch', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    const recipient = await connectClient(b.tokens);

    const updated = nextEvent<{ unread_count: number; last_message_preview: string }>(
      recipient,
      SERVER_EVENTS.CONVERSATION_UPDATED,
    );

    await api
      .post(`${API_PREFIX}/conversations/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'badge me' });

    const payload = await updated;

    expect(payload.unread_count).toBe(1);
    expect(payload.last_message_preview).toBe('badge me');

    await disconnectClient(recipient);
  });
});

describe('match notifications', () => {
  it('tells both people, each about the other', async () => {
    const a = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      display_name: 'Alex',
    });
    const b = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      display_name: 'Blake',
    });

    const clientA = await connectClient(a.tokens);
    const clientB = await connectClient(b.tokens);

    const forA = nextEvent<{ user: { id: string }; mode: string }>(
      clientA,
      SERVER_EVENTS.MATCH_NEW,
    );
    const forB = nextEvent<{ user: { id: string }; mode: string }>(
      clientB,
      SERVER_EVENTS.MATCH_NEW,
    );

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(b.tokens))
      .send({ target_id: a.user_id, action: 'like' });

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(a.tokens))
      .send({ target_id: b.user_id, action: 'like' });

    // Each side receives the OTHER person, so the payload renders directly.
    expect((await forA).user.id).toBe(b.user_id);
    expect((await forB).user.id).toBe(a.user_id);
    expect((await forA).mode).toBe('dating');

    await disconnectClient(clientA);
    await disconnectClient(clientB);
  });

  it('sends nothing on a one-sided like', async () => {
    const a = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const b = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const clientB = await connectClient(b.tokens);
    const quiet = expectNoEvent(clientB, SERVER_EVENTS.MATCH_NEW);

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(a.tokens))
      .send({ target_id: b.user_id, action: 'like' });

    // A like is not a match, and telling the target would leak who liked them
    // — that is behind a paywall.
    await expect(quiet).resolves.toBeUndefined();

    await disconnectClient(clientB);
  });
});

describe('typing indicators', () => {
  it('reaches the other participant', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    const clientA = await connectClient(a.tokens);
    const clientB = await connectClient(b.tokens);

    // No room join needed: typing is addressed to the other participant's own
    // room, so delivery cannot depend on a join the sender cannot observe.
    const typing = nextEvent<{ user_id: string; is_typing: boolean }>(
      clientB,
      SERVER_EVENTS.TYPING,
    );

    clientA.emit('typing:start', { conversation_id });

    const payload = await typing;

    expect(payload.user_id).toBe(a.user_id);
    expect(payload.is_typing).toBe(true);

    await disconnectClient(clientA);
    await disconnectClient(clientB);
  });

  it('does not echo back to the person typing', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);
    const clientA = await connectClient(a.tokens);

    const quiet = expectNoEvent(clientA, SERVER_EVENTS.TYPING);

    clientA.emit('typing:start', { conversation_id });

    await expect(quiet).resolves.toBeUndefined();

    await disconnectClient(clientA);
  });

  it('cannot be joined by someone outside the conversation', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const clientA = await connectClient(a.tokens);
    const intruder = await connectClient(stranger.tokens);

    // Guessing a conversation id must not let anyone watch strangers type.
    const quiet = expectNoEvent(intruder, SERVER_EVENTS.TYPING);

    clientA.emit('typing:start', { conversation_id });

    await expect(quiet).resolves.toBeUndefined();

    await disconnectClient(clientA);
    await disconnectClient(intruder);
  });

  it('rejects a malformed payload with the REST error vocabulary', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const client = await connectClient(viewer.tokens);

    const error = nextEvent<{ code: string }>(client, SERVER_EVENTS.ERROR);

    client.emit('typing:start', { conversation_id: 'not-a-uuid' });

    expect((await error).code).toBe('VALIDATION_FAILED');

    await disconnectClient(client);
  });
});

describe('read receipts', () => {
  it('tells the sender their message was read', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    await api
      .post(`${API_PREFIX}/conversations/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'read me' });

    const clientA = await connectClient(a.tokens);
    const receipt = nextEvent<{ reader_id: string; read_at: string }>(
      clientA,
      SERVER_EVENTS.MESSAGE_READ,
    );

    await api.post(`${API_PREFIX}/conversations/${conversation_id}/read`).set(authHeader(b.tokens));

    const payload = await receipt;

    expect(payload.reader_id).toBe(b.user_id);
    expect(payload.read_at).toMatch(/Z$/);

    await disconnectClient(clientA);
  });

  it('persists when read over the socket, exactly as REST does', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    await api
      .post(`${API_PREFIX}/conversations/${conversation_id}/messages`)
      .set(authHeader(a.tokens))
      .send({ type: 'text', body: 'socket read' });

    const clientB = await connectClient(b.tokens);

    clientB.emit('conversation:read', { conversation_id });
    await settle();

    // The socket path writes through the same service, so read state cannot
    // diverge depending on which one the client happened to call.
    const message = await prisma.message.findFirstOrThrow();
    expect(message.read_at).not.toBeNull();

    const state = await prisma.conversationState.findFirstOrThrow({
      where: { conversation_id, user_id: b.user_id },
    });
    expect(state.unread_count).toBe(0);

    await disconnectClient(clientB);
  });
});

describe('presence', () => {
  it('reports a connected match as online in the conversation list', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    void conversation_id;

    const clientB = await connectClient(b.tokens);
    await settle();

    const response = await api.get(`${API_PREFIX}/conversations`).set(authHeader(a.tokens));

    expect(response.body.data[0].user.is_online).toBe(true);

    await disconnectClient(clientB);
  });

  it('reports offline once the last device disconnects', async () => {
    const { a, b } = await matchPair(Mode.dating);

    const clientB = await connectClient(b.tokens);
    await disconnectClient(clientB);
    await settle();

    const response = await api.get(`${API_PREFIX}/conversations`).set(authHeader(a.tokens));

    expect(response.body.data[0].user.is_online).toBe(false);
  });

  it('stays online while a second device is still connected', async () => {
    const { a, b } = await matchPair(Mode.dating);

    const phone = await connectClient(b.tokens);
    const tablet = await connectClient(b.tokens);

    await disconnectClient(phone);
    await settle();

    // Presence counts connections, not users. A boolean would mark them offline
    // the moment one of two devices closed.
    const response = await api.get(`${API_PREFIX}/conversations`).set(authHeader(a.tokens));
    expect(response.body.data[0].user.is_online).toBe(true);

    await disconnectClient(tablet);
  });

  it('announces coming online to a match', async () => {
    const { a, b } = await matchPair(Mode.dating);

    const clientA = await connectClient(a.tokens);
    const announced = nextEvent<{ user_id: string; is_online: boolean }>(
      clientA,
      SERVER_EVENTS.PRESENCE_UPDATE,
    );

    const clientB = await connectClient(b.tokens);

    const payload = await announced;
    expect(payload.user_id).toBe(b.user_id);
    expect(payload.is_online).toBe(true);

    await disconnectClient(clientA);
    await disconnectClient(clientB);
  });

  it('never announces presence to someone who is not matched', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const watcher = await connectClient(stranger.tokens);
    const quiet = expectNoEvent(watcher, SERVER_EVENTS.PRESENCE_UPDATE);

    const client = await connectClient(viewer.tokens);

    // Presence to strangers is an activity feed on someone who never agreed to
    // share one.
    await expect(quiet).resolves.toBeUndefined();

    await disconnectClient(client);
    await disconnectClient(watcher);
  });

  it('never announces presence across a block', async () => {
    const { a, b } = await matchPair(Mode.dating);
    await createBlock(a.user_id, b.user_id);

    const clientA = await connectClient(a.tokens);
    const quiet = expectNoEvent(clientA, SERVER_EVENTS.PRESENCE_UPDATE);

    const clientB = await connectClient(b.tokens);

    // Telling a blocked person when you are online hands them a live feed of
    // the person who blocked them.
    await expect(quiet).resolves.toBeUndefined();

    await disconnectClient(clientA);
    await disconnectClient(clientB);
  });

  it('refreshes last_active_at on connect', async () => {
    const viewer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      last_active_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const client = await connectClient(viewer.tokens);
    await settle();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: viewer.user_id } });
    expect(Date.now() - user.last_active_at.getTime()).toBeLessThan(60_000);

    await disconnectClient(client);
  });
});
