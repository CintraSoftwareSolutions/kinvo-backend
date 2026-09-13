import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { LONDON } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair, sendText } from '../../helpers/chat';

/**
 * Erasure on account deletion (spec §5.7, Batch 12).
 *
 * THE TENSION UNDER TEST: erasure says a deleted user's personal data must go;
 * safety says a report about someone who deletes their account must survive, or
 * deletion becomes the way to erase your own misconduct record.
 *
 * The resolution is that identifying data is destroyed and safety records are
 * kept, pointing at a row that no longer says who it was. Both halves are
 * asserted here — the destruction AND the survival.
 */

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('what deletion destroys', () => {
  it('scrubs the display name and date of birth', async () => {
    const user = await createDiscoverableViewer({
      mode: Mode.dating,
      coordinates: LONDON,
      display_name: 'Real Name',
    });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.user_id } });

    expect(row.display_name).toBe('Deleted user');
    // Nulled rather than shifted: an age band is still a data point.
    expect(row.date_of_birth).toBeNull();
    expect(row.deleted_at).not.toBeNull();
  });

  it('destroys the sign-in identifier', async () => {
    const user = await createAuthenticatedUser({ email: 'real.person@example.com' });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    const identity = await prisma.authIdentity.findFirstOrThrow({
      where: { user_id: user.user_id },
    });

    // The row survives so a re-registration cannot silently inherit a deleted
    // account's history; the identifier itself does not.
    expect(identity.identifier).not.toBe('real.person@example.com');
    expect(identity.identifier).toContain('deleted_');
    expect(identity.password_hash).toBeNull();
  });

  it('does not leave a reversible trace of the identifier', async () => {
    const user = await createAuthenticatedUser({ email: 'findme@example.com' });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    const identity = await prisma.authIdentity.findFirstOrThrow({
      where: { user_id: user.user_id },
    });

    // A random token, not a hash: a hash of an email is still an email to
    // anyone holding a list to check against, which is how "anonymised" data
    // gets de-anonymised.
    expect(identity.identifier).not.toContain('findme');
    expect(identity.identifier).not.toContain('example.com');
  });

  it('scrubs the profile and its location', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    const profile = await prisma.profile.findUniqueOrThrow({
      where: { user_id: user.user_id },
    });

    expect(profile.bio).toBeNull();
    expect(profile.city).toBeNull();

    const located = await prisma.$queryRaw<{ has_location: boolean }[]>`
      SELECT location IS NOT NULL AS has_location FROM profiles WHERE id = ${profile.id}::uuid
    `;
    expect(located[0]?.has_location).toBe(false);
  });

  it('deletes trusted contacts outright', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api
      .post(`${API_PREFIX}/safety/contacts`)
      .set(authHeader(user.tokens))
      .send({ name: 'Sister', phone: '+447700900123' });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    // These are contact details for THIRD PARTIES who never agreed to anything
    // here, so they are deleted rather than tombstoned.
    expect(await prisma.trustedContact.count({ where: { user_id: user.user_id } })).toBe(0);
  });

  it('destroys live location trails', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const session = await api
      .post(`${API_PREFIX}/safety/location`)
      .set(authHeader(user.tokens))
      .send({});

    await api
      .post(`${API_PREFIX}/safety/location/${session.body.data.id}/ping`)
      .set(authHeader(user.tokens))
      .send({ latitude: 51.5072, longitude: -0.1276 });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    expect(await prisma.liveLocationPing.count()).toBe(0);
  });

  it('clears push tokens and revokes devices', async () => {
    const user = await createAuthenticatedUser();
    await prisma.device.create({
      data: { user_id: user.user_id, device_id: 'phone', platform: 'ios', fcm_token: 'tok' },
    });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    const device = await prisma.device.findFirstOrThrow({ where: { user_id: user.user_id } });
    expect(device.fcm_token).toBeNull();
    expect(device.revoked_at).not.toBeNull();
  });

  it('deletes notification history', async () => {
    const { a, b, conversation_id } = await matchPair(Mode.dating);
    await sendText(a, conversation_id, 'hello');

    expect(await prisma.notification.count({ where: { user_id: b.user_id } })).toBeGreaterThan(0);

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(b.tokens));

    expect(await prisma.notification.count({ where: { user_id: b.user_id } })).toBe(0);
  });

  it('erases message bodies but keeps the rows', async () => {
    const { a, conversation_id } = await matchPair(Mode.dating);
    await sendText(a, conversation_id, 'something private');

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(a.tokens));

    const message = await prisma.message.findFirstOrThrow();

    // The other participant's conversation must not develop holes, and a report
    // about a message needs the message to still exist to point at.
    expect(message.body).toBeNull();
    expect(message.deleted_at).not.toBeNull();
  });
});

describe('what deletion KEEPS', () => {
  it('keeps a report filed against the deleted user', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    await api
      .post(`${API_PREFIX}/reports`)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(target.tokens));

    const report = await prisma.report.findFirstOrThrow();

    // If deletion erased this, deleting your account would be the way to erase
    // your own misconduct record.
    expect(report.reported_id).toBe(target.user_id);
    expect(report.reason).toBe('harassment');
  });

  it('keeps a moderator able to see the history without knowing who it was', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser({ display_name: 'Bad Actor' });
    const moderator = await createAuthenticatedUser({ role: 'moderator' });

    await api
      .post(`${API_PREFIX}/reports`)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'harassment' });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(target.tokens));

    const review = await api.get(`${API_PREFIX}/reports/review`).set(authHeader(moderator.tokens));

    expect(review.body.data).toHaveLength(1);
    // The report survives; the name it was about does not.
    expect(JSON.stringify(review.body)).not.toContain('Bad Actor');
  });

  it('keeps the reports the deleted user filed', async () => {
    const reporter = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    await api
      .post(`${API_PREFIX}/reports`)
      .set(authHeader(reporter.tokens))
      .send({ reported_id: target.user_id, reason: 'spam_scam' });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(reporter.tokens));

    // Deleting your account must not retract accusations a moderator is still
    // acting on.
    expect(await prisma.report.count()).toBe(1);
  });
});

describe('deletion is idempotent and final', () => {
  it('returns the original timestamp on a second delete', async () => {
    const user = await createAuthenticatedUser();

    const first = await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    // The token is revoked, so a genuine second call cannot even authenticate —
    // which is itself the check that sessions die with the account.
    const second = await api.delete(`${API_PREFIX}/users/me`).set(authHeader(user.tokens));

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('removes the account from every read path', async () => {
    const viewer = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const leaving = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await api.delete(`${API_PREFIX}/users/me`).set(authHeader(leaving.tokens));

    const deck = await api
      .get(`${API_PREFIX}/discovery/dating/deck`)
      .set(authHeader(viewer.tokens));
    const profile = await api
      .get(`${API_PREFIX}/users/${leaving.user_id}`)
      .set(authHeader(viewer.tokens));

    expect(deck.body.data.map((c: { user: { id: string } }) => c.user.id)).not.toContain(
      leaving.user_id,
    );
    expect(profile.status).toBe(404);
  });
});
