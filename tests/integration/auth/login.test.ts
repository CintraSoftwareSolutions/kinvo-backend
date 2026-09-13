import { UserStatus, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, TEST_PASSWORD, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { uniqueEmail } from '../../helpers/factories';

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('POST /auth/login', () => {
  it('returns tokens for correct credentials', async () => {
    const { email } = await createAuthenticatedUser();

    const response = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.token_type).toBe('Bearer');
    expect(response.body.data.expires_in).toBe(1800);
  });

  it('accepts the email in any casing', async () => {
    const { email } = await createAuthenticatedUser();

    const response = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email: email.toUpperCase(), password: TEST_PASSWORD });

    expect(response.status).toBe(200);
  });

  it('rejects a wrong password with AUTH_INVALID_CREDENTIALS', async () => {
    const { email } = await createAuthenticatedUser();

    const response = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email, password: 'not the right password' });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_INVALID_CREDENTIALS');
  });

  it('gives an unknown email exactly the same response as a wrong password', async () => {
    const { email } = await createAuthenticatedUser();

    const wrongPassword = await api.post(`${AUTH_BASE}/login`).send({ email, password: 'wrong' });
    const unknownEmail = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email: uniqueEmail(), password: 'wrong' });

    // Any difference here — status, code, or wording — lets an attacker
    // enumerate which addresses have accounts.
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('issues a separate token family per sign-in, so devices are independent', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();

    await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });
    await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });

    const tokens = await prisma.refreshToken.findMany({ where: { user_id: userId } });
    const families = new Set(tokens.map((token) => token.family_id));

    // One from the fixture, two from the logins.
    expect(families.size).toBe(3);
  });

  it('records the device id when the app sends one', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();

    await api
      .post(`${AUTH_BASE}/login`)
      .send({ email, password: TEST_PASSWORD, device_id: 'device-abc-123' });

    const token = await prisma.refreshToken.findFirst({
      where: { user_id: userId, device_id: 'device-abc-123' },
    });

    expect(token).not.toBeNull();
  });

  it('updates last_active_at', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    await prisma.user.update({
      where: { id: userId },
      data: { last_active_at: new Date('2020-01-01T00:00:00Z') },
    });

    await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.last_active_at.getFullYear()).toBeGreaterThan(2020);
  });

  it('blocks a suspended account with ACCOUNT_SUSPENDED', async () => {
    const { email } = await createAuthenticatedUser({ status: UserStatus.suspended });

    const response = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ACCOUNT_SUSPENDED');
  });

  it('refuses a soft-deleted account without revealing it exists', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    await prisma.user.update({ where: { id: userId }, data: { deleted_at: new Date() } });

    const response = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_INVALID_CREDENTIALS');
  });

  it('lets a pending user sign in — onboarding gating happens per route', async () => {
    const { email } = await createAuthenticatedUser({
      status: UserStatus.pending,
      onboarded: false,
    });

    const response = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });

    // Signing in must work, or the user can never complete onboarding.
    expect(response.status).toBe(200);
  });

  it('validates the request body', async () => {
    const response = await api.post(`${AUTH_BASE}/login`).send({ email: 'nope' });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(Object.keys(response.body.error.details).sort()).toEqual(['email', 'password']);
  });
});
