import { API_PREFIX } from '@config/constants';
import { Mode, NotificationCategory, prisma } from '@/db/prisma';
import { setPushProvider } from '@modules/notifications/providers';
import { notify } from '@modules/notifications/notifications.service';
import type { PushMessage, PushProvider, PushResult } from '@/providers/push.provider';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { LONDON } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair, sendText } from '../../helpers/chat';

/**
 * Notifications (spec §7, Batch 11).
 *
 * THE RULE under test throughout: every notification is persisted to the feed
 * AND pushed — never pushed alone. A push-only notification disappears when the
 * banner is dismissed, and the Notifications screen reads the feed.
 */

const NOTIFICATIONS = `${API_PREFIX}/notifications`;

/** Records what would have been pushed, so delivery can be asserted. */
class RecordingPushProvider implements PushProvider {
  readonly name = 'recording';
  readonly isConfigured = true;
  readonly sends: { tokens: string[]; message: PushMessage }[] = [];
  invalidTokens: string[] = [];

  send(tokens: string[], message: PushMessage): Promise<PushResult> {
    this.sends.push({ tokens, message });
    return Promise.resolve({ sent: tokens.length, invalidTokens: this.invalidTokens });
  }
}

/** Fails every send, to prove a dead provider cannot lose a notification. */
class BrokenPushProvider implements PushProvider {
  readonly name = 'broken';
  readonly isConfigured = true;

  send(): Promise<PushResult> {
    return Promise.reject(new Error('push provider exploded'));
  }
}

let push: RecordingPushProvider;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
  push = new RecordingPushProvider();
  setPushProvider(push);
});

afterAll(async () => {
  setPushProvider(null);
  await closeDatabase();
  await disconnectRedis();
});

describe('the feed is the record', () => {
  it('persists a notification even with no devices to push to', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();

    await notify({
      userId: user_id,
      category: 'system',
      title: 'Welcome',
      body: 'Thanks for joining.',
    });

    const response = await api.get(NOTIFICATIONS).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].title).toBe('Welcome');
    expect(response.body.data[0].read_at).toBeNull();
  });

  it('persists it even when the push provider throws', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    setPushProvider(new BrokenPushProvider());

    await notify({
      userId: user_id,
      category: 'system',
      title: 'Still here',
      body: 'Push failed, the feed did not.',
    });

    const response = await api.get(NOTIFICATIONS).set(authHeader(tokens));

    // If push were the record, a provider outage would be silent data loss.
    expect(response.body.data).toHaveLength(1);
  });

  it('records it even when in-app delivery is switched off', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();

    await api
      .patch(`${NOTIFICATIONS}/preferences/system`)
      .set(authHeader(tokens))
      .send({ in_app_enabled: false });

    await notify({ userId: user_id, category: 'system', title: 'Muted', body: 'But recorded.' });

    // The preference controls whether the app surfaces it, not whether it
    // happened — otherwise turning notifications back on loses history.
    expect(await prisma.notification.count({ where: { user_id } })).toBe(1);
  });

  it('returns an empty array, never null', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(NOTIFICATIONS).set(authHeader(tokens));

    expect(response.body.data).toEqual([]);
  });

  it('requires a token', async () => {
    const response = await api.get(NOTIFICATIONS);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('push delivery', () => {
  async function registerDevice(userId: string, tokens: { access_token: string }, token: string) {
    const device = await prisma.device.create({
      data: { user_id: userId, device_id: `dev-${token}`, platform: 'ios' },
    });

    await api
      .post(`${NOTIFICATIONS}/tokens`)
      .set(authHeader(tokens as never))
      .send({ device_id: device.device_id, fcm_token: token });

    return device;
  }

  it('pushes to every registered device', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await registerDevice(user_id, tokens, 'token-phone');
    await registerDevice(user_id, tokens, 'token-tablet');

    await notify({ userId: user_id, category: 'system', title: 'Hello', body: 'Both devices.' });

    expect(push.sends).toHaveLength(1);
    expect(push.sends[0]?.tokens.sort()).toEqual(['token-phone', 'token-tablet']);
  });

  it('carries a deep link and the badge count', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await registerDevice(user_id, tokens, 'token-a');

    await notify({
      userId: user_id,
      category: 'new_match',
      title: 'It is a match!',
      body: 'Say hello.',
      data: { match_id: 'abc', count: 2 },
    });

    const message = push.sends[0]?.message;

    expect(message?.data.match_id).toBe('abc');
    // FCM rejects non-string data values with an error naming neither the key
    // nor the type, so everything is stringified.
    expect(message?.data.count).toBe('2');
    expect(message?.data.category).toBe('new_match');
    expect(message?.badge).toBe(1);
  });

  it('does not push when the category is muted', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await registerDevice(user_id, tokens, 'token-a');

    await api
      .patch(`${NOTIFICATIONS}/preferences/new_message`)
      .set(authHeader(tokens))
      .send({ push_enabled: false });

    await notify({ userId: user_id, category: 'new_message', title: 'Quiet', body: 'No push.' });

    expect(push.sends).toHaveLength(0);
    expect(await prisma.notification.count({ where: { user_id } })).toBe(1);
  });

  it('clears a token the provider reports as permanently dead', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await registerDevice(user_id, tokens, 'token-dead');
    push.invalidTokens = ['token-dead'];

    await notify({ userId: user_id, category: 'system', title: 'x', body: 'y' });

    const device = await prisma.device.findFirstOrThrow({ where: { user_id } });

    // Otherwise every future send retries an address that can never receive
    // anything and the failure count grows forever.
    expect(device.fcm_token).toBeNull();
  });

  it('does not push to a revoked device', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    const device = await registerDevice(user_id, tokens, 'token-gone');

    await prisma.device.update({
      where: { id: device.id },
      data: { revoked_at: new Date() },
    });

    await notify({ userId: user_id, category: 'system', title: 'x', body: 'y' });

    expect(push.sends).toHaveLength(0);
  });
});

describe('POST /notifications/tokens', () => {
  it('registers a token against a signed-in device', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await prisma.device.create({
      data: { user_id, device_id: 'my-phone', platform: 'ios' },
    });

    const response = await api
      .post(`${NOTIFICATIONS}/tokens`)
      .set(authHeader(tokens))
      .send({ device_id: 'my-phone', fcm_token: 'fcm-abc' });

    expect(response.status).toBe(200);
    expect(response.body.data.registered).toBe(true);
  });

  it('404s for a device that is not signed in', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(`${NOTIFICATIONS}/tokens`)
      .set(authHeader(tokens))
      .send({ device_id: 'never-seen', fcm_token: 'fcm-abc' });

    expect(response.status).toBe(404);
  });

  it('moves a token off its previous device on reinstall', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await prisma.device.create({ data: { user_id, device_id: 'old', platform: 'ios' } });
    await prisma.device.create({ data: { user_id, device_id: 'new', platform: 'ios' } });

    await api
      .post(`${NOTIFICATIONS}/tokens`)
      .set(authHeader(tokens))
      .send({ device_id: 'old', fcm_token: 'shared-token' });

    await api
      .post(`${NOTIFICATIONS}/tokens`)
      .set(authHeader(tokens))
      .send({ device_id: 'new', fcm_token: 'shared-token' });

    const old = await prisma.device.findFirstOrThrow({ where: { user_id, device_id: 'old' } });
    const fresh = await prisma.device.findFirstOrThrow({ where: { user_id, device_id: 'new' } });

    // FCM issues one token per install. Leaving it on both would fan one push
    // out to a device that no longer exists.
    expect(old.fcm_token).toBeNull();
    expect(fresh.fcm_token).toBe('shared-token');
  });

  it('stops pushing to a device that signs out', async () => {
    const { email } = await createAuthenticatedUser();
    const login = await api
      .post(`${API_PREFIX}/auth/login`)
      .set('X-Device-Id', 'shared-phone')
      .set('X-Platform', 'android')
      .send({ email, password: 'correct horse battery staple' });

    await api
      .post(`${NOTIFICATIONS}/tokens`)
      .set('Authorization', `Bearer ${login.body.data.access_token}`)
      .send({ device_id: 'shared-phone', fcm_token: 'fcm-shared' });

    await api
      .post(`${API_PREFIX}/auth/logout`)
      .send({ refresh_token: login.body.data.refresh_token });

    // Otherwise the account's message previews keep arriving on a phone
    // nobody is signed in to.
    const device = await prisma.device.findFirstOrThrow({ where: { device_id: 'shared-phone' } });
    expect(device.fcm_token).toBeNull();
  });

  it('unregisters without ending the session', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await prisma.device.create({
      data: { user_id, device_id: 'my-phone', platform: 'ios', fcm_token: 'abc' },
    });

    const response = await api.delete(`${NOTIFICATIONS}/tokens/my-phone`).set(authHeader(tokens));

    expect(response.status).toBe(200);

    const device = await prisma.device.findFirstOrThrow({ where: { user_id } });
    // "Stop pushing to me" is not "sign me out" — revoking a device is the
    // security action, this is a preference.
    expect(device.fcm_token).toBeNull();
    expect(device.revoked_at).toBeNull();
  });
});

describe('reading the feed', () => {
  it('marks one read', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    const created = await notify({
      userId: user_id,
      category: 'system',
      title: 'x',
      body: 'y',
    });

    const response = await api.post(`${NOTIFICATIONS}/${created.id}/read`).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.read_at).not.toBeNull();
  });

  it('404s on someone else’s notification', async () => {
    const owner = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();
    const created = await notify({
      userId: owner.user_id,
      category: 'system',
      title: 'x',
      body: 'y',
    });

    const response = await api
      .post(`${NOTIFICATIONS}/${created.id}/read`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
    expect(
      (await prisma.notification.findFirstOrThrow({ where: { id: created.id } })).read_at,
    ).toBeNull();
  });

  it('marks all read', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    for (let i = 0; i < 3; i += 1) {
      await notify({ userId: user_id, category: 'system', title: `n${i}`, body: 'x' });
    }

    const response = await api.post(`${NOTIFICATIONS}/read-all`).set(authHeader(tokens));

    expect(response.body.data.marked).toBe(3);
    expect(await prisma.notification.count({ where: { user_id, read_at: null } })).toBe(0);
  });

  it('filters to unread only', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    const first = await notify({ userId: user_id, category: 'system', title: 'a', body: 'x' });
    await notify({ userId: user_id, category: 'system', title: 'b', body: 'x' });

    await api.post(`${NOTIFICATIONS}/${first.id}/read`).set(authHeader(tokens));

    const response = await api.get(`${NOTIFICATIONS}?unread_only=true`).set(authHeader(tokens));

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].title).toBe('b');
  });

  it('reports the unread count', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    await notify({ userId: user_id, category: 'system', title: 'a', body: 'x' });
    await notify({ userId: user_id, category: 'system', title: 'b', body: 'x' });

    const response = await api.get(`${NOTIFICATIONS}/unread-count`).set(authHeader(tokens));

    expect(response.body.data.unread_count).toBe(2);
  });

  it('paginates newest first without repeating', async () => {
    const { user_id, tokens } = await createAuthenticatedUser();
    for (let i = 0; i < 5; i += 1) {
      await notify({ userId: user_id, category: 'system', title: `n${i}`, body: 'x' });
    }

    const first = await api.get(`${NOTIFICATIONS}?limit=2`).set(authHeader(tokens));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.pagination.has_more).toBe(true);

    const second = await api
      .get(`${NOTIFICATIONS}?limit=2&cursor=${first.body.meta.pagination.next_cursor}`)
      .set(authHeader(tokens));

    const firstIds = first.body.data.map((n: { id: string }) => n.id);
    const secondIds = second.body.data.map((n: { id: string }) => n.id);

    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });
});

describe('preferences', () => {
  it('returns every category with defaults filled in', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(`${NOTIFICATIONS}/preferences`).set(authHeader(tokens));

    expect(response.status).toBe(200);

    // Derived from the enum rather than hardcoded. A literal count means every
    // new notification category breaks this test for no reason, which trains
    // people to bump the number without reading what it was protecting — that
    // EVERY category comes back, defaults filled in, not that there are eight.
    const allCategories = Object.values(NotificationCategory);
    expect(response.body.data.preferences).toHaveLength(allCategories.length);
    expect(
      response.body.data.preferences.map((p: { category: string }) => p.category).sort(),
    ).toEqual([...allCategories].sort());

    const system = response.body.data.preferences.find(
      (p: { category: string }) => p.category === 'system',
    );

    // A user who never opened settings has no rows. Missing must mean "the
    // sensible default", not "off".
    expect(system.push_enabled).toBe(true);
    expect(system.in_app_enabled).toBe(true);
    expect(system.email_enabled).toBe(false);
  });

  it('updates one category without touching the others', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api
      .patch(`${NOTIFICATIONS}/preferences/new_message`)
      .set(authHeader(tokens))
      .send({ push_enabled: false });

    const response = await api.get(`${NOTIFICATIONS}/preferences`).set(authHeader(tokens));
    const list = response.body.data.preferences as { category: string; push_enabled: boolean }[];

    expect(list.find((p) => p.category === 'new_message')?.push_enabled).toBe(false);
    expect(list.find((p) => p.category === 'new_match')?.push_enabled).toBe(true);
  });

  it('refuses to mute safety notifications', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${NOTIFICATIONS}/preferences/safety`)
      .set(authHeader(tokens))
      .send({ push_enabled: false });

    // spec §5.7: these carry emergency and moderation outcomes. Someone who
    // muted safety a month ago missing the result of a report they filed is the
    // failure this product cannot have.
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'BAD_REQUEST');
  });

  it('allows turning safety EMAIL off, since that is not the alert', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${NOTIFICATIONS}/preferences/safety`)
      .set(authHeader(tokens))
      .send({ email_enabled: false });

    expect(response.status).toBe(200);
  });

  it('rejects an empty update', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${NOTIFICATIONS}/preferences/new_match`)
      .set(authHeader(tokens))
      .send({});

    expect(response.status).toBe(400);
  });
});

describe('notifications from real events', () => {
  it('tells both people about a new match', async () => {
    const { a, b } = await matchPair(Mode.dating);

    const forA = await prisma.notification.findMany({
      where: { user_id: a.user_id, category: 'new_match' },
    });
    const forB = await prisma.notification.findMany({
      where: { user_id: b.user_id, category: 'new_match' },
    });

    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]?.body).toContain('Blake');
    expect(forB[0]?.body).toContain('Alex');
  });

  it('points a match notification at its conversation', async () => {
    const { b, conversation_id } = await matchPair(Mode.dating);

    const forB = await prisma.notification.findFirstOrThrow({
      where: { user_id: b.user_id, category: 'new_match' },
    });

    // Tapping it opens the conversation directly.
    expect(forB.data).toMatchObject({ conversation_id });
  });

  it('tells the recipient about a message, titled with the sender', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    await sendText(a, conversation_id, 'hello there');

    const forB = await prisma.notification.findMany({
      where: { user_id: b.user_id, category: 'new_message' },
    });

    expect(forB).toHaveLength(1);
    expect(forB[0]?.title).toBe('Alex');
    expect(forB[0]?.body).toBe('hello there');
  });

  it('announces nothing for a conversation the recipient muted', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await api
      .patch(`${API_PREFIX}/conversations/${conversation_id}`)
      .set(authHeader(b.tokens))
      .send({ is_muted: true });

    const response = await sendText(a, conversation_id, 'are you there?');

    expect(response.status).toBe(201);
    expect(
      await prisma.notification.count({ where: { user_id: b.user_id, category: 'new_message' } }),
    ).toBe(0);
    // Still delivered, and still unread.
    const state = await prisma.conversationState.findFirstOrThrow({
      where: { conversation_id, user_id: b.user_id },
    });
    expect(state.unread_count).toBe(1);
  });

  it("reading a conversation marks its message notifications read, and no one else's", async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await sendText(a, conversation_id, 'one');
    await sendText(a, conversation_id, 'two');
    await notify({ userId: b.user_id, category: 'system', title: 'Hello', body: 'Still unread.' });

    await api.post(`${API_PREFIX}/conversations/${conversation_id}/read`).set(authHeader(b.tokens));

    const unread = await prisma.notification.findMany({
      where: { user_id: b.user_id, read_at: null },
      select: { category: true },
    });
    // The match notification and the system one stay; the messages are read.
    expect(unread.map((row) => row.category).sort()).toEqual(['new_match', 'system']);
  });

  it('does not notify the sender about their own message', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);

    await sendText(a, conversation_id, 'hello');

    expect(
      await prisma.notification.count({ where: { user_id: a.user_id, category: 'new_message' } }),
    ).toBe(0);
  });

  it('tells someone they were liked WITHOUT naming who', async () => {
    const admirer = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      display_name: 'Secret Admirer',
    });
    const target = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(admirer.tokens))
      .send({ target_id: target.user_id, action: 'like' });

    const received = await prisma.notification.findMany({
      where: { user_id: target.user_id, category: 'new_like' },
    });

    expect(received).toHaveLength(1);
    // Who liked you is behind a paywall. Naming them in a banner gives the
    // feature away.
    expect(JSON.stringify(received[0])).not.toContain('Secret Admirer');
    expect(JSON.stringify(received[0])).not.toContain(admirer.user_id);
  });

  it('sends no like notification when the like completes a match', async () => {
    const { a, b } = await matchPair(Mode.dating);

    // The second like formed a match, so it announces a match, not a like.
    const likes = await prisma.notification.count({ where: { category: 'new_like' } });
    const matches = await prisma.notification.count({ where: { category: 'new_match' } });

    expect(likes).toBe(1); // only the first, one-sided like
    expect(matches).toBe(2); // both sides
    void a;
    void b;
  });

  it('sends no notification for a pass', async () => {
    const actor = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const target = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api
      .post(`${API_PREFIX}/discovery/dating/swipe`)
      .set(authHeader(actor.tokens))
      .send({ target_id: target.user_id, action: 'pass' });

    expect(await prisma.notification.count({ where: { user_id: target.user_id } })).toBe(0);
  });
});

describe('GET /notifications/badges', () => {
  it('returns counts for all five tabs', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(`${NOTIFICATIONS}/badges`).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.data).sort()).toEqual([
      'discover',
      'matches',
      'notifications',
      'plans',
      'requests',
      'total',
    ]);
  });

  it('counts unread messages against the matches tab', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);

    await sendText(a, conversation_id, 'one');
    await sendText(a, conversation_id, 'two');

    const response = await api.get(`${NOTIFICATIONS}/badges`).set(authHeader(b.tokens));

    expect(response.body.data.matches).toBe(2);
  });

  it('excludes deck cards from the total', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api.get(`${API_PREFIX}/discovery/dating/deck`).set(authHeader(viewer.tokens));

    const response = await api.get(`${NOTIFICATIONS}/badges`).set(authHeader(viewer.tokens));

    // Cards waiting is not something the user is behind on. Folding it into the
    // total makes the app badge permanently non-zero.
    expect(response.body.data.discover).toBeGreaterThan(0);
    expect(response.body.data.total).toBe(0);
  });
});
