import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import { touchDevice } from '@modules/settings/devices.service';
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

  function bearer(login: { body: { data: { access_token: string } } }) {
    return { Authorization: `Bearer ${login.body.data.access_token}` };
  }

  async function deviceRowId(login: Parameters<typeof bearer>[0], deviceId: string) {
    const list = await api.get(DEVICES).set(bearer(login));
    return list.body.data.devices.find((d: { device_id: string }) => d.device_id === deviceId)
      .id as string;
  }

  it("stops a revoked device's access token at once, not when it expires", async () => {
    const { email } = await createAuthenticatedUser();
    const stolen = await signInWithDevice(email, 'stolen-phone');
    const mine = await signInWithDevice(email, 'my-phone');

    await api.delete(`${DEVICES}/${await deviceRowId(mine, 'stolen-phone')}`).set(bearer(mine));

    // The access token has up to 30 minutes left, and a stolen phone must not
    // get them.
    const response = await api.get(`${API_PREFIX}/users/me`).set(bearer(stolen));
    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');

    const stillMine = await api.get(`${API_PREFIX}/users/me`).set(bearer(mine));
    expect(stillMine.status).toBe(200);
  });

  it('stops every other device at once when signing out everywhere else', async () => {
    const { email } = await createAuthenticatedUser();
    const other = await signInWithDevice(email, 'device-a');
    const current = await signInWithDevice(email, 'device-b');

    await api.delete(`${DEVICES}/others`).set({ ...bearer(current), 'X-Device-Id': 'device-b' });

    expect((await api.get(`${API_PREFIX}/users/me`).set(bearer(other))).status).toBe(401);
    expect((await api.get(`${API_PREFIX}/users/me`).set(bearer(current))).status).toBe(200);
  });

  it('takes a device off the list when it logs out', async () => {
    const { email } = await createAuthenticatedUser();
    const leaving = await signInWithDevice(email, 'device-a');
    const staying = await signInWithDevice(email, 'device-b');

    await api.post(`${AUTH}/logout`).send({ refresh_token: leaving.body.data.refresh_token });

    const list = await api.get(DEVICES).set(bearer(staying));
    // Listed as signed in, it would invite the user to sign out a session
    // that has already ended.
    expect(list.body.data.devices.map((d: { device_id: string }) => d.device_id)).toEqual([
      'device-b',
    ]);
    expect((await api.get(`${API_PREFIX}/users/me`).set(bearer(leaving))).status).toBe(401);
  });

  it('lists a device again when someone signs in on it again', async () => {
    const { email } = await createAuthenticatedUser();
    const first = await signInWithDevice(email, 'device-a');
    await api.post(`${AUTH}/logout`).send({ refresh_token: first.body.data.refresh_token });

    const again = await signInWithDevice(email, 'device-a');

    const list = await api.get(DEVICES).set(bearer(again));
    expect(list.body.data.devices).toHaveLength(1);
    expect((await api.get(`${API_PREFIX}/users/me`).set(bearer(again))).status).toBe(200);
  });

  it('records the model and system version, and keeps them current on refresh', async () => {
    const { email } = await createAuthenticatedUser();
    const headers = {
      'X-Device-Id': 'pixel',
      'X-Platform': 'android',
      'X-Device-Model': 'Pixel 8',
    };

    const login = await api
      .post(`${AUTH}/login`)
      .set({ ...headers, 'X-App-Version': '1.0.0', 'X-OS-Version': 'Android 15' })
      .send({ email, password: 'correct horse battery staple' });

    const before = await api.get(DEVICES).set(bearer(login));
    expect(before.body.data.devices[0]).toMatchObject({
      model: 'Pixel 8',
      os_version: 'Android 15',
      app_version: '1.0.0',
    });

    const refreshed = await api
      .post(`${AUTH}/refresh`)
      .set({ ...headers, 'X-App-Version': '1.1.0', 'X-OS-Version': 'Android 16' })
      .send({ refresh_token: login.body.data.refresh_token });

    const after = await api.get(DEVICES).set(bearer(refreshed));
    expect(after.body.data.devices[0]).toMatchObject({
      model: 'Pixel 8',
      os_version: 'Android 16',
      app_version: '1.1.0',
    });
  });

  it('cuts an over-long header to fit rather than losing the device', async () => {
    const { email } = await createAuthenticatedUser();

    const login = await api
      .post(`${AUTH}/login`)
      .set({ 'X-Device-Id': 'long', 'X-Platform': 'ios', 'X-Device-Model': 'M'.repeat(100) })
      .send({ email, password: 'correct horse battery staple' });

    const list = await api.get(DEVICES).set(bearer(login));
    expect(list.body.data.devices[0].model).toBe('M'.repeat(64));
  });

  it('never brings back a signed-out device on a refresh', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    await signInWithDevice(email, 'phone');
    await prisma.device.updateMany({
      where: { user_id: userId, device_id: 'phone' },
      data: { revoked_at: new Date() },
    });

    // A refresh racing a sign-out from another phone must not undo it.
    await touchDevice({ userId, deviceId: 'phone', platform: 'ios' });

    const row = await prisma.device.findFirstOrThrow({
      where: { user_id: userId, device_id: 'phone' },
    });
    expect(row.revoked_at).not.toBeNull();
  });

  it('signs every device out when the password changes', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    const a = await signInWithDevice(email, 'device-a');
    await signInWithDevice(email, 'device-b');

    const changed = await api.post(`${AUTH}/change-password`).set(bearer(a)).send({
      current_password: 'correct horse battery staple',
      new_password: 'an entirely new passphrase 42',
    });
    expect(changed.status).toBe(200);

    expect((await api.get(`${API_PREFIX}/users/me`).set(bearer(a))).status).toBe(401);
    const devices = await prisma.device.findMany({ where: { user_id: userId } });
    expect(devices.every((device) => device.revoked_at !== null)).toBe(true);
  });
});
