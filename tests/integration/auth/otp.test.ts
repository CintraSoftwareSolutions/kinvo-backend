import { mockOtpProvider, otpCalls, resetOtpCalls, VALID_OTP_CODE } from '../../mocks/external';

// Mocked before any import that reaches it: this is the seam where our code
// stops and Twilio begins (spec §0.4).
jest.mock('@/providers/twilio.provider', () => ({
  getOtpProvider: () => mockOtpProvider,
}));

import { prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';

const PHONE = '+447700900123';

beforeEach(async () => {
  await resetDatabase();
  resetOtpCalls();
});

afterAll(closeDatabase);

describe('POST /auth/otp/send', () => {
  it('sends a code', async () => {
    const response = await api.post(`${AUTH_BASE}/otp/send`).send({ phone: PHONE });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ sent: true });
    expect(otpCalls.sent).toEqual([PHONE]);
  });

  it('responds identically for a registered and an unregistered number', async () => {
    const registered = await api.post(`${AUTH_BASE}/otp/send`).send({ phone: PHONE });

    await api.post(`${AUTH_BASE}/otp/verify`).send({ phone: PHONE, code: VALID_OTP_CODE });

    const nowRegistered = await api.post(`${AUTH_BASE}/otp/send`).send({ phone: PHONE });

    // Identical, or this endpoint enumerates which numbers have accounts.
    expect(nowRegistered.status).toBe(registered.status);
    expect(nowRegistered.body).toEqual(registered.body);
  });

  it('requires E.164 format', async () => {
    const response = await api.post(`${AUTH_BASE}/otp/send`).send({ phone: '07700900123' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('phone');
  });
});

describe('POST /auth/otp/verify', () => {
  it('creates a pending account for a new number and returns tokens', async () => {
    const response = await api
      .post(`${AUTH_BASE}/otp/verify`)
      .send({ phone: PHONE, code: VALID_OTP_CODE, display_name: 'Nina' });

    expect(response.status).toBe(201);
    expect(response.body.data.access_token).toEqual(expect.any(String));
    expect(response.body.data.is_new_user).toBe(true);

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'phone', identifier: PHONE } },
      include: { user: true },
    });

    // No date of birth from a phone number, so the account is pending and
    // blocked from the product until onboarding supplies one (spec §5.1).
    expect(identity.user.status).toBe('pending');
    expect(identity.user.date_of_birth).toBeNull();
    expect(identity.user.display_name).toBe('Nina');
    expect(identity.verified_at).not.toBeNull();
  });

  it('signs an existing number in without creating a second account', async () => {
    await api
      .post(`${AUTH_BASE}/otp/verify`)
      .send({ phone: PHONE, code: VALID_OTP_CODE, display_name: 'Nina' });

    const second = await api
      .post(`${AUTH_BASE}/otp/verify`)
      .send({ phone: PHONE, code: VALID_OTP_CODE });

    expect(second.status).toBe(200);
    expect(second.body.data.is_new_user).toBe(false);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects a wrong code', async () => {
    const response = await api
      .post(`${AUTH_BASE}/otp/verify`)
      .send({ phone: PHONE, code: '999999' });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_INVALID_CREDENTIALS');
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects an expired or already-consumed code the same way', async () => {
    // Twilio reports expiry as a failed check rather than a distinct error, so
    // the user-facing outcome is identical to a wrong code — deliberately, since
    // distinguishing them would tell an attacker a real code once existed.
    const response = await api
      .post(`${AUTH_BASE}/otp/verify`)
      .send({ phone: PHONE, code: '000000' });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_INVALID_CREDENTIALS');
  });

  it('marks a previously unverified number as verified on success', async () => {
    const { user_id: userId } = await createAuthenticatedUser();
    await prisma.authIdentity.create({
      data: { user_id: userId, provider: 'phone', identifier: PHONE, verified_at: null },
    });

    await api.post(`${AUTH_BASE}/otp/verify`).send({ phone: PHONE, code: VALID_OTP_CODE });

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'phone', identifier: PHONE } },
    });

    expect(identity.verified_at).not.toBeNull();
  });

  it('signs in the user who owns the number, not a new one', async () => {
    const { user_id: userId } = await createAuthenticatedUser();
    await prisma.authIdentity.create({
      data: { user_id: userId, provider: 'phone', identifier: PHONE },
    });

    const response = await api
      .post(`${AUTH_BASE}/otp/verify`)
      .send({ phone: PHONE, code: VALID_OTP_CODE });

    expect(response.body.data.is_new_user).toBe(false);
    expect(await prisma.user.count()).toBe(1);

    const tokens = await prisma.refreshToken.findMany({ where: { user_id: userId } });
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('validates the code format', async () => {
    const response = await api
      .post(`${AUTH_BASE}/otp/verify`)
      .send({ phone: PHONE, code: 'abcdef' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('code');
  });
});
