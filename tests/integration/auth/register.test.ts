import { prisma } from '@/db/prisma';
import { verifyPassword } from '@modules/auth/password.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, TEST_PASSWORD } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { uniqueEmail } from '../../helpers/factories';

beforeEach(resetDatabase);
afterAll(closeDatabase);

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    display_name: 'Sarah',
    date_of_birth: '1999-03-14',
    ...overrides,
  };
}

describe('POST /auth/register', () => {
  it('creates an account and returns the spec 4.3 token shape', async () => {
    const response = await api.post(`${AUTH_BASE}/register`).send(validBody());

    expect(response.status).toBe(201);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toEqual({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: 'Bearer',
      expires_in: 1800,
    });
  });

  it('starts the user as pending, not active (spec §5.1 state machine)', async () => {
    const body = validBody();
    await api.post(`${AUTH_BASE}/register`).send(body);

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'email', identifier: body.email.toLowerCase() } },
      include: { user: true },
    });

    expect(identity.user.status).toBe('pending');
    expect(identity.user.onboarded_at).toBeNull();
    expect(identity.user.subscription_tier).toBe('free');
  });

  it('stores the password as an argon2id hash, never in the clear', async () => {
    const body = validBody();
    await api.post(`${AUTH_BASE}/register`).send(body);

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'email', identifier: body.email.toLowerCase() } },
    });

    expect(identity.password_hash).toEqual(expect.stringContaining('$argon2id$'));
    expect(identity.password_hash).not.toContain(TEST_PASSWORD);
    expect(await verifyPassword(identity.password_hash!, TEST_PASSWORD)).toBe(true);
  });

  it('stores date of birth and no age column (spec §5.1)', async () => {
    const body = validBody({ date_of_birth: '1997-06-30' });
    await api.post(`${AUTH_BASE}/register`).send(body);

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'email', identifier: body.email.toLowerCase() } },
      include: { user: true },
    });

    expect(identity.user.date_of_birth?.toISOString().slice(0, 10)).toBe('1997-06-30');
    expect(identity.user).not.toHaveProperty('age');
  });

  it('lower-cases the email so one address cannot register twice by casing', async () => {
    const email = uniqueEmail();
    await api.post(`${AUTH_BASE}/register`).send(validBody({ email: email.toUpperCase() }));

    const stored = await prisma.authIdentity.findUnique({
      where: { provider_identifier: { provider: 'email', identifier: email.toLowerCase() } },
    });

    expect(stored).not.toBeNull();
  });

  describe('under-18 rejection (spec §5.1 — legal requirement)', () => {
    function yearsAgo(years: number): string {
      const date = new Date();
      date.setUTCFullYear(date.getUTCFullYear() - years);
      return date.toISOString().slice(0, 10);
    }

    it('rejects someone under 18', async () => {
      const response = await api
        .post(`${AUTH_BASE}/register`)
        .send(validBody({ date_of_birth: yearsAgo(16) }));

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
      expect(response.body.error.details).toHaveProperty('date_of_birth');
    });

    it('rejects someone one day short of 18', async () => {
      const date = new Date();
      date.setUTCFullYear(date.getUTCFullYear() - 18);
      date.setUTCDate(date.getUTCDate() + 1);

      const response = await api
        .post(`${AUTH_BASE}/register`)
        .send(validBody({ date_of_birth: date.toISOString().slice(0, 10) }));

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    });

    it('accepts someone who turned 18 today', async () => {
      const date = new Date();
      date.setUTCFullYear(date.getUTCFullYear() - 18);

      const response = await api
        .post(`${AUTH_BASE}/register`)
        .send(validBody({ date_of_birth: date.toISOString().slice(0, 10) }));

      expect(response.status).toBe(201);
    });

    it('writes nothing when the age check fails', async () => {
      await api.post(`${AUTH_BASE}/register`).send(validBody({ date_of_birth: yearsAgo(15) }));

      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.authIdentity.count()).toBe(0);
    });

    it('rejects a future date of birth', async () => {
      const response = await api
        .post(`${AUTH_BASE}/register`)
        .send(validBody({ date_of_birth: '2099-01-01' }));

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    });
  });

  describe('validation', () => {
    it('rejects a malformed email with a field-keyed detail', async () => {
      const response = await api.post(`${AUTH_BASE}/register`).send(validBody({ email: 'nope' }));

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('email');
    });

    it('rejects a short password', async () => {
      const response = await api.post(`${AUTH_BASE}/register`).send(validBody({ password: 'abc' }));

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('password');
    });

    it('rejects a date of birth that is not YYYY-MM-DD', async () => {
      const response = await api
        .post(`${AUTH_BASE}/register`)
        .send(validBody({ date_of_birth: '14/03/1999' }));

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('date_of_birth');
    });

    it('reports every failing field at once', async () => {
      const response = await api
        .post(`${AUTH_BASE}/register`)
        .send({ email: 'bad', password: 'x' });

      expect(Object.keys(response.body.error.details).sort()).toEqual([
        'date_of_birth',
        'display_name',
        'email',
        'password',
      ]);
    });
  });

  it('refuses a duplicate email with 409, not a second account', async () => {
    const email = uniqueEmail();
    await api.post(`${AUTH_BASE}/register`).send(validBody({ email }));

    const response = await api.post(`${AUTH_BASE}/register`).send(validBody({ email }));

    expect(response.status).toBe(409);
    expectErrorEnvelope(response.body, 'CONFLICT');
    expect(await prisma.user.count()).toBe(1);
  });
});
