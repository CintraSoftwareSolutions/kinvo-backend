import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import { expireSnoozes } from '@modules/settings/settings.service';
import { visibleUserFilter } from '@modules/safety/block.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';

/** Settings, snooze, and connected devices (spec §7, Batch 5). */

const SETTINGS = `${API_PREFIX}/settings`;
const DEVICES = `${API_PREFIX}/devices`;
const AUTH = `${API_PREFIX}/auth`;

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('GET /settings', () => {
  it('creates defaults on first read', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(SETTINGS).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toMatchObject({
      theme: 'system',
      text_scale: 1,
      reduce_motion: false,
      distance_unit: 'miles',
      show_distance: true,
      incognito: false,
      language: 'en',
    });
  });

  it('reports snooze state alongside the rest', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(SETTINGS).set(authHeader(tokens));

    expect(response.body.data.snooze).toEqual({ is_snoozed: false, ends_at: null });
  });

  it('requires authentication', async () => {
    const response = await api.get(SETTINGS);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('PATCH /settings', () => {
  it('updates only what is sent', async () => {
    const { tokens } = await createAuthenticatedUser();
    const auth = authHeader(tokens);

    await api.patch(SETTINGS).set(auth).send({ theme: 'dark', reduce_motion: true });
    const response = await api.patch(SETTINGS).set(auth).send({ language: 'ur' });

    expect(response.body.data.theme).toBe('dark');
    expect(response.body.data.reduce_motion).toBe(true);
    expect(response.body.data.language).toBe('ur');
  });

  it('persists across devices, which is the point of storing it server-side', async () => {
    const { tokens, email } = await createAuthenticatedUser();

    await api.patch(SETTINGS).set(authHeader(tokens)).send({ theme: 'dark', text_scale: 1.4 });

    // A different sign-in, as a fresh install would be.
    const second = await api
      .post(`${AUTH}/login`)
      .send({ email, password: 'correct horse battery staple' });

    const response = await api
      .get(SETTINGS)
      .set({ Authorization: `Bearer ${second.body.data.access_token}` });

    expect(response.body.data.theme).toBe('dark');
    expect(response.body.data.text_scale).toBe(1.4);
  });

  it('rejects a text scale outside the accessible range', async () => {
    const { tokens } = await createAuthenticatedUser();

    for (const text_scale of [0.4, 3.0]) {
      const response = await api.patch(SETTINGS).set(authHeader(tokens)).send({ text_scale });
      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('text_scale');
    }
  });

  it('rejects an unknown theme', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.patch(SETTINGS).set(authHeader(tokens)).send({ theme: 'midnight' });

    expect(response.status).toBe(400);
  });

  it('rejects a malformed language tag', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(SETTINGS)
      .set(authHeader(tokens))
      .send({ language: 'English' });

    expect(response.status).toBe(400);
  });

  it('rejects an empty body', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.patch(SETTINGS).set(authHeader(tokens)).send({});

    expect(response.status).toBe(400);
  });

  it("cannot touch another user's settings", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();

    await api.patch(SETTINGS).set(authHeader(alice.tokens)).send({ theme: 'dark' });

    const bobSettings = await api.get(SETTINGS).set(authHeader(bob.tokens));
    expect(bobSettings.body.data.theme).toBe('system');
  });

  it('keeps distance_unit a display preference only', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(SETTINGS)
      .set(authHeader(tokens))
      .send({ distance_unit: 'kilometres' });

    // spec §4.6: the API is metres regardless of what this says.
    expect(response.body.data.distance_unit).toBe('kilometres');
  });
});

describe('snooze (spec §5.6)', () => {
  it('hides the profile without deleting anything', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    const response = await api.post(`${SETTINGS}/snooze`).set(authHeader(tokens)).send({});

    expect(response.status).toBe(200);
    expect(response.body.data.snooze.is_snoozed).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // The account stays active and matches survive — that is why snooze is a
    // flag rather than a status.
    expect(user.status).toBe('active');
    expect(user.is_snoozed).toBe(true);
    expect(user.deleted_at).toBeNull();
  });

  it('removes the user from the shared exclusion clause while snoozed', async () => {
    const viewer = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    await api.post(`${SETTINGS}/snooze`).set(authHeader(target.tokens)).send({});

    const visible = await prisma.user.findMany({
      where: visibleUserFilter(viewer.user_id, []),
      select: { id: true },
    });

    // The clause every discovery query composes must not return them.
    expect(visible.map((u) => u.id)).not.toContain(target.user_id);
  });

  it('accepts an optional end time', async () => {
    const { tokens } = await createAuthenticatedUser();
    const endsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const response = await api
      .post(`${SETTINGS}/snooze`)
      .set(authHeader(tokens))
      .send({ ends_at: endsAt });

    expect(response.status).toBe(200);
    expect(response.body.data.snooze.ends_at).toBe(endsAt);
  });

  it('refuses an end time in the past', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(`${SETTINGS}/snooze`)
      .set(authHeader(tokens))
      .send({ ends_at: new Date(Date.now() - 1000).toISOString() });

    expect(response.status).toBe(400);
  });

  it('resumes on request', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api.post(`${SETTINGS}/snooze`).set(authHeader(tokens)).send({});
    const response = await api.delete(`${SETTINGS}/snooze`).set(authHeader(tokens));

    expect(response.body.data.snooze).toEqual({ is_snoozed: false, ends_at: null });
  });

  it('lifts an expired snooze but leaves an open-ended one alone', async () => {
    const timed = await createAuthenticatedUser();
    const openEnded = await createAuthenticatedUser();

    await prisma.user.update({
      where: { id: timed.user_id },
      data: { is_snoozed: true, snooze_ends_at: new Date(Date.now() - 60_000) },
    });
    await prisma.user.update({
      where: { id: openEnded.user_id },
      data: { is_snoozed: true, snooze_ends_at: null },
    });

    const cleared = await expireSnoozes();

    expect(cleared).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: timed.user_id } })).is_snoozed).toBe(
      false,
    );
    // No end time means "until I say so", not "until a job notices".
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: openEnded.user_id } })).is_snoozed,
    ).toBe(true);
  });
});

describe('connected devices', () => {
  const DEVICE = 'device-aaa-111';

  async function signInWithDevice(email: string, deviceId: string) {
    return api
      .post(`${AUTH}/login`)
      .set('X-Device-Id', deviceId)
      .set('X-Platform', 'ios')
      .set('X-App-Version', '1.2.0')
      .send({ email, password: 'correct horse battery staple' });
  }

  it('records the device used to sign in', async () => {
    const { email } = await createAuthenticatedUser();
    const login = await signInWithDevice(email, DEVICE);

    const response = await api
      .get(DEVICES)
      .set({ Authorization: `Bearer ${login.body.data.access_token}`, 'X-Device-Id': DEVICE });

    expect(response.status).toBe(200);
    expect(response.body.data.devices).toHaveLength(1);
    expect(response.body.data.devices[0]).toMatchObject({
      device_id: DEVICE,
      platform: 'ios',
      app_version: '1.2.0',
      is_current: true,
    });
  });

  it('flags only the requesting device as current', async () => {
    const { email } = await createAuthenticatedUser();
    await signInWithDevice(email, 'device-a');
    const second = await signInWithDevice(email, 'device-b');

    const response = await api
      .get(DEVICES)
      .set({ Authorization: `Bearer ${second.body.data.access_token}`, 'X-Device-Id': 'device-b' });

    const current = response.body.data.devices.filter((d: { is_current: boolean }) => d.is_current);
    expect(current).toHaveLength(1);
    expect(current[0].device_id).toBe('device-b');
  });

  it('actually ends the session when a device is revoked', async () => {
    const { email } = await createAuthenticatedUser();
    const stolen = await signInWithDevice(email, 'stolen-phone');
    const mine = await signInWithDevice(email, 'my-phone');

    const list = await api
      .get(DEVICES)
      .set({ Authorization: `Bearer ${mine.body.data.access_token}`, 'X-Device-Id': 'my-phone' });
    const stolenRow = list.body.data.devices.find(
      (d: { device_id: string }) => d.device_id === 'stolen-phone',
    );

    const revoke = await api
      .delete(`${DEVICES}/${stolenRow.id}`)
      .set({ Authorization: `Bearer ${mine.body.data.access_token}` });
    expect(revoke.status).toBe(200);

    // Removing a row from a list while the session keeps working would be a
    // comforting lie on a security screen.
    const refresh = await api
      .post(`${AUTH}/refresh`)
      .send({ refresh_token: stolen.body.data.refresh_token });
    expect(refresh.status).toBe(401);

    // The revoking device is untouched.
    const stillFine = await api
      .post(`${AUTH}/refresh`)
      .send({ refresh_token: mine.body.data.refresh_token });
    expect(stillFine.status).toBe(200);
  });

  it('signs out everywhere else while keeping the current device', async () => {
    const { email } = await createAuthenticatedUser();
    const a = await signInWithDevice(email, 'device-a');
    const b = await signInWithDevice(email, 'device-b');
    const c = await signInWithDevice(email, 'device-c');

    const response = await api
      .delete(`${DEVICES}/others`)
      .set({ Authorization: `Bearer ${c.body.data.access_token}`, 'X-Device-Id': 'device-c' });

    expect(response.status).toBe(200);
    expect(response.body.data.revoked_count).toBe(2);

    for (const other of [a, b]) {
      const refresh = await api
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: other.body.data.refresh_token });
      expect(refresh.status).toBe(401);
    }

    const kept = await api
      .post(`${AUTH}/refresh`)
      .send({ refresh_token: c.body.data.refresh_token });
    expect(kept.status).toBe(200);
  });

  it("returns 404 for another user's device, never 403", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();

    const aliceLogin = await signInWithDevice(alice.email, 'alice-phone');
    const list = await api
      .get(DEVICES)
      .set({ Authorization: `Bearer ${aliceLogin.body.data.access_token}` });
    const aliceDevice = list.body.data.devices[0];

    const response = await api.delete(`${DEVICES}/${aliceDevice.id}`).set(authHeader(bob.tokens));

    // A 403 would confirm the device exists.
    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });

  it('returns an empty array rather than null when nothing is signed in', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(DEVICES).set(authHeader(tokens));

    expect(response.body.data.devices).toEqual([]);
  });
});
