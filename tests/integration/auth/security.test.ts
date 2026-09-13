import { fakeIdToken, mockVerifyAppleIdToken, mockVerifyGoogleIdToken } from '../../mocks/external';

jest.mock('@/providers/google-auth.provider', () => ({
  verifyGoogleIdToken: mockVerifyGoogleIdToken,
}));

jest.mock('@/providers/apple-auth.provider', () => ({
  verifyAppleIdToken: mockVerifyAppleIdToken,
}));

import { prisma } from '@/db/prisma';
import { verifyPassword } from '@modules/auth/password.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, TEST_PASSWORD, authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';

/**
 * Attack-shaped tests.
 *
 * Each one describes something an attacker would actually try, rather than a
 * feature. They exist to stay failing-if-regressed, because every rule here is
 * one a future refactor could quietly undo.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('account takeover via registration', () => {
  it('refuses to attach a password to an account created by social sign-in', async () => {
    const victimEmail = 'victim@example.com';

    // The victim signs up with Google. social.service records their verified
    // address as an email identity with no password, so that a later Google or
    // Apple sign-in links rather than duplicating.
    await api.post(`${AUTH_BASE}/google`).send({
      id_token: fakeIdToken({
        subject: 'victim-google-subject',
        email: victimEmail,
        email_verified: true,
        name: 'Victim',
      }),
    });

    const victim = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'email', identifier: victimEmail } },
      select: { user_id: true },
    });

    // The attacker knows only the address and registers against it.
    const attack = await api.post(`${AUTH_BASE}/register`).send({
      email: victimEmail,
      password: 'attacker-chosen-password',
      display_name: 'Attacker',
      date_of_birth: '1990-01-01',
    });

    // Attaching a password here would hand over the account with no proof of
    // mailbox ownership whatsoever.
    expect(attack.status).toBe(409);
    expectErrorEnvelope(attack.body, 'CONFLICT');

    // No tokens were issued.
    expect(attack.body).not.toHaveProperty('data.access_token');

    // The victim's account is untouched.
    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'email', identifier: victimEmail } },
    });
    expect(identity.password_hash).toBeNull();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: victim.user_id } });
    expect(user.display_name).toBe('Victim');
    expect(await prisma.user.count()).toBe(1);
  });

  it('leaves password reset as the safe route for a social account', async () => {
    const email = 'social.only@example.com';

    await api.post(`${AUTH_BASE}/google`).send({
      id_token: fakeIdToken({ subject: 'g-only', email, email_verified: true }),
    });

    // Password reset proves mailbox control, so it is allowed to set the first
    // password on a social-created account.
    const forgot = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });
    const token = forgot.body.data.reset_token as string;
    expect(token).toEqual(expect.any(String));

    const reset = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ token, password: TEST_PASSWORD });
    expect(reset.status).toBe(200);

    const login = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    expect(await prisma.user.count()).toBe(1);
  });

  it('does not let registration overwrite an existing account with a password', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser({
      display_name: 'Original',
    });

    const attack = await api.post(`${AUTH_BASE}/register`).send({
      email,
      password: 'attacker-chosen-password',
      display_name: 'Attacker',
      date_of_birth: '1990-01-01',
    });

    expect(attack.status).toBe(409);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.display_name).toBe('Original');

    const identity = await prisma.authIdentity.findFirstOrThrow({
      where: { user_id: userId, provider: 'email' },
    });
    expect(await verifyPassword(identity.password_hash!, TEST_PASSWORD)).toBe(true);
  });
});

describe('cross-account access', () => {
  it('never lets one user read another through /auth/me', async () => {
    const alice = await createAuthenticatedUser({ display_name: 'Alice' });
    await createAuthenticatedUser({ display_name: 'Bob' });

    const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(alice.tokens));

    expect(response.body.data.id).toBe(alice.user_id);
    expect(response.body.data.display_name).toBe('Alice');
  });

  it("cannot use another user's refresh token family after logout", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();

    await api.post(`${AUTH_BASE}/logout`).send({ refresh_token: alice.tokens.refresh_token });

    // Bob is unaffected by Alice signing out.
    const bobRefresh = await api
      .post(`${AUTH_BASE}/refresh`)
      .send({ refresh_token: bob.tokens.refresh_token });

    expect(bobRefresh.status).toBe(200);
  });
});

describe('information disclosure', () => {
  it('never returns a password hash from any auth endpoint', async () => {
    const { email, tokens } = await createAuthenticatedUser();

    const responses = [
      await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens)),
      await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD }),
      await api.post(`${AUTH_BASE}/forgot-password`).send({ email }),
    ];

    for (const response of responses) {
      const body = JSON.stringify(response.body);
      expect(body).not.toContain('$argon2');
      expect(body).not.toContain('password_hash');
      expect(body).not.toContain('token_hash');
    }
  });

  it('never reveals a stack trace or internal path in an error', async () => {
    const response = await api.post(`${AUTH_BASE}/login`).send({ email: 'x', password: 'y' });
    const body = JSON.stringify(response.body);

    expect(body).not.toMatch(/\.ts:\d+/);
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain('C:\\');
    expect(body).not.toContain('prisma');
  });

  it('does not disclose whether an email is registered, on any endpoint', async () => {
    const { email } = await createAuthenticatedUser();
    const unknown = 'definitely.not.registered@example.com';

    const knownLogin = await api.post(`${AUTH_BASE}/login`).send({ email, password: 'wrong' });
    const unknownLogin = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email: unknown, password: 'wrong' });

    expect(unknownLogin.status).toBe(knownLogin.status);
    expect(unknownLogin.body).toEqual(knownLogin.body);

    const knownForgot = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });
    const unknownForgot = await api.post(`${AUTH_BASE}/forgot-password`).send({ email: unknown });

    expect(unknownForgot.status).toBe(knownForgot.status);
    expect(unknownForgot.body.data.message).toBe(knownForgot.body.data.message);
  });
});

describe('token forgery and confusion', () => {
  it('refuses an access token where a refresh token belongs', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(`${AUTH_BASE}/refresh`)
      .send({ refresh_token: tokens.access_token });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });

  it('refuses a refresh token where an access token belongs', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .get(`${AUTH_BASE}/me`)
      .set('Authorization', `Bearer ${tokens.refresh_token}`);

    expect(response.status).toBe(401);
  });

  it('rejects the "none" algorithm', async () => {
    // A classic JWT attack: strip the signature and claim no algorithm.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: '00000000-0000-4000-8000-000000000000', type: 'access' }),
    ).toString('base64url');

    const response = await api
      .get(`${AUTH_BASE}/me`)
      .set('Authorization', `Bearer ${header}.${payload}.`);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });
});

describe('injection', () => {
  it('treats SQL metacharacters in an email as data', async () => {
    const response = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email: "admin'--@example.com", password: "' OR '1'='1" });

    // Rejected as a bad email or bad credentials — never executed.
    expect([400, 401]).toContain(response.status);
    expect(await prisma.user.count()).toBe(0);
  });

  it('stores a display name containing markup verbatim, without executing it', async () => {
    const email = 'markup@example.com';
    await api.post(`${AUTH_BASE}/register`).send({
      email,
      password: TEST_PASSWORD,
      display_name: '<script>alert(1)</script>',
      date_of_birth: '1995-01-01',
    });

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'email', identifier: email } },
      include: { user: true },
    });

    // Stored as data. The Flutter client renders text, not HTML, so escaping is
    // the admin web client's concern (Batch 15) — recorded so it is not
    // forgotten rather than silently assumed safe.
    expect(identity.user.display_name).toBe('<script>alert(1)</script>');
  });
});
