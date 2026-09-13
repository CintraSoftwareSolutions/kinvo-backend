import { mockOtpProvider, VALID_OTP_CODE } from '../../mocks/external';

jest.mock('@/providers/twilio.provider', () => ({
  getOtpProvider: () => mockOtpProvider,
}));

import { isDatabaseReachable, prisma } from '@/db/prisma';
import { connectRedis, disconnectRedis, isRedisReachable } from '@/db/redis';
import { attachVerifiedPhone } from '@modules/auth/otp.service';
import {
  pruneExpiredTokens,
  revokeAllTokensForUser,
  signAccessToken,
  verifyAccessToken,
} from '@modules/auth/token.service';
import { ApiError } from '@utils/api-error';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { createAuthenticatedUser } from '../../helpers/auth';

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('session maintenance', () => {
  it('revokes every live token for a user', async () => {
    const { user_id: userId } = await createAuthenticatedUser();
    await createAuthenticatedUser(); // a bystander

    await revokeAllTokensForUser(userId);

    const revoked = await prisma.refreshToken.findMany({ where: { user_id: userId } });
    expect(revoked.every((token) => token.revoked_at !== null)).toBe(true);

    const others = await prisma.refreshToken.findMany({ where: { user_id: { not: userId } } });
    expect(others.every((token) => token.revoked_at === null)).toBe(true);
  });

  it('deletes expired refresh tokens and leaves live ones alone', async () => {
    const { user_id: userId } = await createAuthenticatedUser();

    await prisma.refreshToken.create({
      data: {
        user_id: userId,
        family_id: '11111111-1111-4111-8111-111111111111',
        token_hash: 'expired-token-hash',
        expires_at: new Date(Date.now() - 60_000),
      },
    });

    const before = await prisma.refreshToken.count();
    const removed = await pruneExpiredTokens();

    expect(removed).toBe(1);
    expect(await prisma.refreshToken.count()).toBe(before - 1);
  });

  it('prunes nothing when everything is current', async () => {
    await createAuthenticatedUser();
    expect(await pruneExpiredTokens()).toBe(0);
  });
});

describe('access token round trip', () => {
  it('verifies a token it just signed', () => {
    const token = signAccessToken('9f1e2b3c-0000-4000-8000-000000000000');
    const payload = verifyAccessToken(token);

    expect(payload.sub).toBe('9f1e2b3c-0000-4000-8000-000000000000');
    expect(payload.type).toBe('access');
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken('9f1e2b3c-0000-4000-8000-000000000000');
    const tampered = `${token.slice(0, -4)}AAAA`;

    expect(() => verifyAccessToken(tampered)).toThrow(ApiError);
  });
});

describe('attaching a phone number to an existing account', () => {
  const PHONE = '+447700900999';

  it('adds a verified phone identity', async () => {
    const { user_id: userId } = await createAuthenticatedUser();

    await attachVerifiedPhone(userId, PHONE, VALID_OTP_CODE);

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'phone', identifier: PHONE } },
    });

    expect(identity.user_id).toBe(userId);
    expect(identity.verified_at).not.toBeNull();
  });

  it('rejects a wrong code and stores nothing', async () => {
    const { user_id: userId } = await createAuthenticatedUser();

    await expect(attachVerifiedPhone(userId, PHONE, '000111')).rejects.toThrow(ApiError);

    const identity = await prisma.authIdentity.findUnique({
      where: { provider_identifier: { provider: 'phone', identifier: PHONE } },
    });
    expect(identity).toBeNull();
  });

  it('refuses a number already attached to someone else', async () => {
    const owner = await createAuthenticatedUser();
    const other = await createAuthenticatedUser();

    await attachVerifiedPhone(owner.user_id, PHONE, VALID_OTP_CODE);

    await expect(attachVerifiedPhone(other.user_id, PHONE, VALID_OTP_CODE)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('is idempotent for the same owner', async () => {
    const { user_id: userId } = await createAuthenticatedUser();

    await attachVerifiedPhone(userId, PHONE, VALID_OTP_CODE);
    await attachVerifiedPhone(userId, PHONE, VALID_OTP_CODE);

    const count = await prisma.authIdentity.count({
      where: { provider: 'phone', identifier: PHONE },
    });
    expect(count).toBe(1);
  });
});

describe('dependency reachability probes', () => {
  // The client is lazy and tests disable the offline queue, so the connection
  // is opened explicitly here — and closed again, or Jest reports a leaked
  // handle and cannot exit.
  beforeAll(connectRedis);
  afterAll(disconnectRedis);

  it('reports Postgres as reachable', async () => {
    expect(await isDatabaseReachable()).toBe(true);
  });

  it('reports Redis as reachable', async () => {
    // Redis is not on any request path yet, but rate limiting depends on it in
    // production, so a broken connection should surface here.
    expect(await isRedisReachable()).toBe(true);
  });
});
