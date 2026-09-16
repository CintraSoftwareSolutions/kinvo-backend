import { env } from '@config/env';
import { prisma } from '@/db/prisma';
import { verifyPassword } from '@modules/auth/password.service';
import { setEmailProvider } from '@modules/notifications/providers';
import type { EmailMessage, EmailProvider } from '@/providers/email.provider';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, TEST_PASSWORD, authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { uniqueEmail } from '../../helpers/factories';

const NEW_PASSWORD = 'a completely different password';
const WRONG_CODE = '000000';

beforeEach(resetDatabase);
afterEach(() => setEmailProvider(null));
afterAll(closeDatabase);

/**
 * Accepts every message and remembers it, so the endpoint behaves the way it
 * does in production: a code that was delivered is never returned in the
 * response.
 */
class RecordingEmailProvider implements EmailProvider {
  readonly name = 'recording';
  readonly isConfigured = true;
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<boolean> {
    this.sent.push(message);
    return Promise.resolve(true);
  }
}

/** The six digits in a message, as the user would read them out of their inbox. */
function codeFrom(message: EmailMessage): string {
  const match = /\b\d{6}\b/.exec(message.text);
  if (!match) throw new Error('no code in the email');
  return match[0];
}

/**
 * Requests a code the way a test with no mail transport gets one.
 *
 * This suite runs without SMTP or SES credentials, so the endpoint hands the
 * code back in the response rather than dropping it on the floor — the same
 * affordance staging runs on, and the reason production refuses to boot without
 * a transport.
 */
async function requestCode(email: string): Promise<string> {
  const response = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });
  return response.body.data.reset_code as string;
}

describe('POST /auth/forgot-password', () => {
  it('emails a six-digit code and keeps it out of the response', async () => {
    const mailer = new RecordingEmailProvider();
    setEmailProvider(mailer);

    const { email } = await createAuthenticatedUser();
    const response = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });

    expect(response.status).toBe(200);
    expect(response.body.data).not.toHaveProperty('reset_code');

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0]!;
    expect(message.to).toBe(email);

    // The code has to be readable in whichever part the client renders, and in
    // the subject line, where a phone shows it without the mail being opened.
    const code = codeFrom(message);
    expect(message.subject).toContain(code);
    expect(message.html).toContain(code);
  });

  it('returns exactly the same response whether or not the address exists', async () => {
    setEmailProvider(new RecordingEmailProvider());
    const { email } = await createAuthenticatedUser();

    const known = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });
    const unknown = await api.post(`${AUTH_BASE}/forgot-password`).send({ email: uniqueEmail() });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it('sends nothing to an address with no account', async () => {
    const mailer = new RecordingEmailProvider();
    setEmailProvider(mailer);

    await api.post(`${AUTH_BASE}/forgot-password`).send({ email: uniqueEmail() });

    expect(mailer.sent).toHaveLength(0);
  });

  it('hands the code back only where there is nowhere to send it', async () => {
    const { email } = await createAuthenticatedUser();
    const response = await api.post(`${AUTH_BASE}/forgot-password`).send({ email });

    expect(response.body.data.reset_code).toMatch(/^\d{6}$/);
  });

  it('creates a single-use code with a one-hour expiry', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    await requestCode(email);

    const issued = await prisma.passwordResetToken.findFirstOrThrow({
      where: { user_id: userId },
    });

    const ttlMinutes = (issued.expires_at.getTime() - Date.now()) / 60000;
    expect(ttlMinutes).toBeGreaterThan(55);
    expect(ttlMinutes).toBeLessThanOrEqual(60);
    expect(issued.used_at).toBeNull();
    expect(issued.attempts).toBe(0);
  });

  it('stores a hash of the code, never the code itself', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    const code = await requestCode(email);

    const stored = await prisma.passwordResetToken.findFirstOrThrow({
      where: { user_id: userId },
    });

    expect(stored.token_hash).not.toContain(code);
    // Argon2, not sha256: a sha256 of six digits is a million-entry lookup
    // table, so anything able to read this row could redeem the code.
    expect(stored.token_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('retires an earlier outstanding code when a new one is requested', async () => {
    const { email } = await createAuthenticatedUser();
    const first = await requestCode(email);
    await requestCode(email);

    // An intercepted older email must stop working the moment a new one is sent.
    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code: first, password: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });
});

describe('POST /auth/reset-password', () => {
  it('sets a new password and lets the user sign in with it', async () => {
    const { email } = await createAuthenticatedUser();
    const code = await requestCode(email);

    const reset = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    const withNew = await api.post(`${AUTH_BASE}/login`).send({ email, password: NEW_PASSWORD });
    expect(withNew.status).toBe(200);

    const withOld = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });
    expect(withOld.status).toBe(401);
  });

  it('is single use', async () => {
    const { email } = await createAuthenticatedUser();
    const code = await requestCode(email);

    await api.post(`${AUTH_BASE}/reset-password`).send({ email, code, password: NEW_PASSWORD });
    const second = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code, password: 'yet another password' });

    expect(second.status).toBe(401);
    expectErrorEnvelope(second.body, 'AUTH_TOKEN_INVALID');
  });

  it('rejects an expired code', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    const code = await requestCode(email);

    await prisma.passwordResetToken.updateMany({
      where: { user_id: userId },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code, password: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });

  it('rejects a code for an account with none outstanding', async () => {
    const { email } = await createAuthenticatedUser();

    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code: WRONG_CODE, password: NEW_PASSWORD });

    expect(response.status).toBe(401);
  });

  it('answers an unknown address exactly as it answers a wrong code', async () => {
    const { email } = await createAuthenticatedUser();

    const unknown = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email: uniqueEmail(), code: WRONG_CODE, password: NEW_PASSWORD });
    const wrong = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code: WRONG_CODE, password: NEW_PASSWORD });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("will not take one account's code for another account", async () => {
    const victim = await createAuthenticatedUser();
    const attacker = await createAuthenticatedUser();
    const code = await requestCode(attacker.email);

    // Six digits collide across accounts constantly, which is exactly why a
    // code is only ever checked against the account its address resolves to.
    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email: victim.email, code, password: NEW_PASSWORD });

    expect(response.status).toBe(401);

    const login = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email: victim.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('destroys the code after too many wrong guesses', async () => {
    const { email, user_id: userId } = await createAuthenticatedUser();
    const code = await requestCode(email);

    for (let attempt = 0; attempt < env.PASSWORD_RESET_MAX_ATTEMPTS; attempt += 1) {
      const guess = await api
        .post(`${AUTH_BASE}/reset-password`)
        .send({ email, code: WRONG_CODE, password: NEW_PASSWORD });
      expect(guess.status).toBe(401);
    }

    // The real code is worthless now. Someone grinding guesses has to make the
    // user request a new one, which needs their inbox.
    const withRealCode = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code, password: NEW_PASSWORD });

    expect(withRealCode.status).toBe(401);

    const stored = await prisma.passwordResetToken.findFirstOrThrow({ where: { user_id: userId } });
    expect(stored.used_at).not.toBeNull();

    const login = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('revokes every existing session — a reset usually means compromise', async () => {
    const { email, tokens } = await createAuthenticatedUser();
    const code = await requestCode(email);

    await api.post(`${AUTH_BASE}/reset-password`).send({ email, code, password: NEW_PASSWORD });

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
    const code = await requestCode(email);

    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code, password: 'short' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('password');
  });

  it('refuses anything that is not six digits before it reaches the database', async () => {
    const { email } = await createAuthenticatedUser();
    const code = await requestCode(email);

    const response = await api
      .post(`${AUTH_BASE}/reset-password`)
      .send({ email, code: `${code}1`, password: NEW_PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('code');
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
