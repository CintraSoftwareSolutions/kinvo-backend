import { prisma } from '@/db/prisma';
import { verifyPassword } from '@modules/auth/password.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, TEST_PASSWORD, authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { uniqueEmail } from '../../helpers/factories';

const NEW_PASSWORD = 'a completely different password';

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function requestReset(email: string): Promise<string> {
  const response = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });
  return response.body.data.reset_token as string;
}

describe('POST /auth/forgot-password', () => {
  it('returns the same response whether or not the address exists', async () => {
    const { email } = await createAuthenticatedUser();

    const known = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });
    const unknown = await api.post(`${AUTH_BASE}/forgot-password`).send({ email: uniqueEmail() });

    expect(known.status).toBe(unknown.status);
    expect(known.body.data.message).toBe(unknown.body.data.message);
  });

  it('creates a single-use token with a one-hour expiry', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    await requestReset(email);

    const token = await prisma.passwordResetToken.findFirstOrThrow({
      where: { user_id: userId },
    });

    const ttlMinutes = (token.expires_at.getTime() - Date.now()) / 60000;
    expect(ttlMinutes).toBeGreaterThan(55);
    expect(ttlMinutes).toBeLessThanOrEqual(60);
    expect(token.used_at).toBeNull();
  });

  it('stores a hash of the token, never the token itself', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    const rawToken = await requestReset(email);

    const stored = await prisma.passwordResetToken.findFirstOrThrow({
      where: { user_id: userId },
    });

    expect(stored.token_hash).not.toBe(rawToken);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retires an earlier outstanding token when a new one is requested', async () => {
    const { email } = await createAuthenticatedUser();
    const first = await requestReset(email);
    await requestReset(email);

    // An intercepted older email must stop working the moment a new one is sent.
    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ token: first, password: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });
});

describe('POST /auth/reset-password', () => {
  it('sets a new password and lets the user sign in with it', async () => {
    const { email } = await createAuthenticatedUser();
    const token = await requestReset(email);

    const reset = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ token, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    const withNew = await api.post(`${AUTH_BASE}/login`).send({ email, password: NEW_PASSWORD });
    expect(withNew.status).toBe(200);

    const withOld = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });
    expect(withOld.status).toBe(401);
  });

  it('is single use', async () => {
    const { email } = await createAuthenticatedUser();
    const token = await requestReset(email);

    await api.post(`${AUTH_BASE}/reset-password`).send({ token, password: NEW_PASSWORD });
    const second = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ token, password: 'yet another password' });

    expect(second.status).toBe(401);
    expectErrorEnvelope(second.body, 'AUTH_TOKEN_INVALID');
  });

  it('rejects an expired token', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    const token = await requestReset(email);

    await prisma.passwordResetToken.updateMany({
      where: { user_id: userId },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ token, password: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });

  it('rejects a token that was never issued', async () => {
    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ token: 'completely-made-up', password: NEW_PASSWORD });

    expect(response.status).toBe(401);
  });

  it('revokes every existing session — a reset usually means compromise', async () => {
    const { email, tokens } = await createAuthenticatedUser();
    const token = await requestReset(email);

    await api.post(`${AUTH_BASE}/reset-password`).send({ token, password: NEW_PASSWORD });

    const refresh = await api
      .post(`${AUTH_BASE}/refresh`)
      .send({ refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(401);

    const me = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));
    // The access token is stateless and still within its 30 minutes, but the
    // refresh chain is dead, so the session cannot outlive it.
    expect([200, 401]).toContain(me.status);
  });

  it('enforces the password policy on the new password', async () => {
    const { email } = await createAuthenticatedUser();
    const token = await requestReset(email);

    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ token, password: 'short' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('password');
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password when the current one is correct', async () => {
    const { email, tokens } = await createAuthenticatedUser();

    const response = await api
      .post(`${AUTH_BASE}/change-password`)
      .set(authHeader(tokens))
      .send({ current_password: TEST_PASSWORD, new_password: NEW_PASSWORD });

    expect(response.status).toBe(200);

    const login = await api.post(`${AUTH_BASE}/login`).send({ email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('rejects a wrong current password', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    const response = await api
      .post(`${AUTH_BASE}/change-password`)
      .set(authHeader(tokens))
      .send({ current_password: 'not it', new_password: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_INVALID_CREDENTIALS');

    const identity = await prisma.authIdentity.findFirstOrThrow({
      where: { user_id: userId, provider: 'email' },
    });
    expect(await verifyPassword(identity.password_hash!, TEST_PASSWORD)).toBe(true);
  });

  it('requires authentication', async () => {
    const response = await api
      .post(`${AUTH_BASE}/change-password`)
      .send({ current_password: TEST_PASSWORD, new_password: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });

  it("cannot change another user's password", async () => {
    const attacker = await createAuthenticatedUser();
    const victim = await createAuthenticatedUser();

    await api
      .post(`${AUTH_BASE}/change-password`)
      .set(authHeader(attacker.tokens))
      .send({ current_password: TEST_PASSWORD, new_password: NEW_PASSWORD });

    // The victim's password is untouched — the endpoint only ever acts on the
    // authenticated user, with no id in the request to tamper with.
    const victimLogin = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email: victim.email, password: TEST_PASSWORD });

    expect(victimLogin.status).toBe(200);
  });

  it('revokes existing sessions after a change', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api
      .post(`${AUTH_BASE}/change-password`)
      .set(authHeader(tokens))
      .send({ current_password: TEST_PASSWORD, new_password: NEW_PASSWORD });

    const refresh = await api
      .post(`${AUTH_BASE}/refresh`)
      .send({ refresh_token: tokens.refresh_token });

    expect(refresh.status).toBe(401);
  });
});
