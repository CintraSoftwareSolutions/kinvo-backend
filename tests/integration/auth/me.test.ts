import jwt from 'jsonwebtoken';

import { API_PREFIX } from '@config/constants';
import { env } from '@config/env';
import { UserStatus, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, authHeader, bearer, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('GET /auth/me', () => {
  it('returns the authenticated user', async () => {
    const {
      tokens,
      user_id: userId,
      email,
    } = await createAuthenticatedUser({
      display_name: 'Sarah',
    });

    const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toMatchObject({
      id: userId,
      display_name: 'Sarah',
      status: 'active',
      role: 'user',
      is_verified: false,
      is_onboarded: true,
      subscription_tier: 'free',
    });
    expect(response.body.data.identities).toEqual([
      { provider: 'email', identifier: email, is_verified: true },
    ]);
  });

  it('computes age from date of birth and never stores one (spec §5.1)', async () => {
    const { tokens } = await createAuthenticatedUser({
      date_of_birth: new Date(Date.UTC(1999, 2, 14)),
    });

    const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

    expect(response.body.data.date_of_birth).toBe('1999-03-14');
    expect(response.body.data.age).toEqual(expect.any(Number));
    expect(response.body.data.age).toBeGreaterThanOrEqual(18);
  });

  it('returns null rather than omitting a missing date of birth (spec §4.6)', async () => {
    const { tokens } = await createAuthenticatedUser({ date_of_birth: null, onboarded: false });

    const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

    expect(response.body.data).toHaveProperty('date_of_birth', null);
    expect(response.body.data).toHaveProperty('age', null);
  });

  it('returns timestamps as UTC ISO-8601 with Z (spec §4.6)', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

    expect(response.body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('never exposes a password hash', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

    expect(JSON.stringify(response.body)).not.toContain('argon2');
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  describe('the three auth failure codes stay distinct (spec §4.3)', () => {
    it('returns AUTH_REQUIRED when no token is sent', async () => {
      const response = await api.get(`${AUTH_BASE}/me`);

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
    });

    it('returns AUTH_TOKEN_EXPIRED for an expired access token', async () => {
      const { user_id: userId } = await createAuthenticatedUser();
      const expired = jwt.sign({ sub: userId, type: 'access' }, env.JWT_ACCESS_SECRET, {
        expiresIn: -60,
        issuer: env.JWT_ISSUER,
      });

      const response = await api.get(`${AUTH_BASE}/me`).set(bearer(expired));

      // The app refreshes silently on this one. Returning INVALID here would
      // log out every user whose token merely aged out.
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'AUTH_TOKEN_EXPIRED');
    });

    it('returns AUTH_TOKEN_INVALID for a forged token', async () => {
      const forged = jwt.sign(
        { sub: '00000000-0000-4000-8000-000000000000', type: 'access' },
        'an-attacker-chosen-secret-value-000000000',
        { expiresIn: 3600 },
      );

      const response = await api.get(`${AUTH_BASE}/me`).set(bearer(forged));

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
    });

    it('returns AUTH_TOKEN_INVALID when the user no longer exists', async () => {
      const { tokens, user_id: userId } = await createAuthenticatedUser();
      await prisma.user.delete({ where: { id: userId } });

      const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
    });

    it('returns AUTH_TOKEN_INVALID for a soft-deleted user', async () => {
      const { tokens, user_id: userId } = await createAuthenticatedUser();
      await prisma.user.update({ where: { id: userId }, data: { deleted_at: new Date() } });

      const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
    });
  });

  describe('malformed Authorization headers', () => {
    it.each([
      ['no scheme', 'sometoken'],
      ['wrong scheme', 'Basic sometoken'],
      ['empty bearer', 'Bearer '],
      ['scheme only', 'Bearer'],
    ])('rejects %s with AUTH_REQUIRED', async (_label, header) => {
      const response = await api.get(`${AUTH_BASE}/me`).set('Authorization', header);

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
    });

    it('accepts a lower-case bearer scheme', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api
        .get(`${AUTH_BASE}/me`)
        .set('Authorization', `bearer ${tokens.access_token}`);

      expect(response.status).toBe(200);
    });
  });

  it('reflects a suspension immediately, without waiting for the token to expire', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.suspended, suspension_reason: 'Breached the guidelines.' },
    });

    const response = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ACCOUNT_SUSPENDED');
    expect(response.body.error.message).toBe('Breached the guidelines.');
  });

  it('is not reachable at an unversioned path', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get('/auth/me').set(authHeader(tokens));

    expect(response.status).toBe(404);
  });

  it('lives under the versioned prefix', async () => {
    expect(AUTH_BASE).toBe(`${API_PREFIX}/auth`);
  });
});
