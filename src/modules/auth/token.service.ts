import { randomUUID } from 'node:crypto';

import jwt, { type SignOptions } from 'jsonwebtoken';

import { TOKEN_LIFETIMES } from '@config/constants';
import { env } from '@config/env';
import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { generateSecureToken, sha256 } from '@utils/hash';
import { logger } from '@utils/logger';
import type { AccessTokenPayload, AuthTokens, RefreshTokenPayload } from './auth.types';

/**
 * Token issuance and rotation (spec §4.3).
 *
 * Access tokens are stateless and short-lived (30 minutes). Refresh tokens are
 * stateful, long-lived (60 days), rotated on every use, and grouped into
 * families so a replayed token can invalidate an entire compromised chain.
 *
 * The stored value is a SHA-256 hash, never the token itself: a leaked database
 * must not yield working refresh tokens.
 */

const ACCESS_TTL_SECONDS = TOKEN_LIFETIMES.ACCESS_SECONDS;
const REFRESH_TTL_SECONDS = TOKEN_LIFETIMES.REFRESH_SECONDS;

function signOptions(expiresIn: number): SignOptions {
  return { expiresIn, issuer: env.JWT_ISSUER, algorithm: 'HS256' };
}

export function signAccessToken(userId: string): string {
  const payload: AccessTokenPayload = { sub: userId, type: 'access' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, signOptions(ACCESS_TTL_SECONDS));
}

function signRefreshToken(userId: string, tokenId: string, familyId: string): string {
  const payload: RefreshTokenPayload = {
    sub: userId,
    jti: tokenId,
    fam: familyId,
    type: 'refresh',
  };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, signOptions(REFRESH_TTL_SECONDS));
}

/**
 * Distinguishes expiry from invalidity, because the app does different things:
 * AUTH_TOKEN_EXPIRED means refresh silently and retry; AUTH_TOKEN_INVALID means
 * log out. Collapsing them into a generic 401 forces the client to guess, and
 * the usual guess is wrong for the first case (spec §4.3).
 */
function verify<T>(token: string, secret: string): T {
  try {
    return jwt.verify(token, secret, { issuer: env.JWT_ISSUER }) as T;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(ERROR_CODES.AUTH_TOKEN_EXPIRED);
    }
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID);
  }
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = verify<AccessTokenPayload>(token, env.JWT_ACCESS_SECRET);

  // A refresh token is signed with a different secret and cannot verify here,
  // but the explicit check keeps the contract obvious.
  if (payload.type !== 'access') {
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID);
  }

  return payload;
}

function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = verify<RefreshTokenPayload>(token, env.JWT_REFRESH_SECRET);

  if (payload.type !== 'refresh') {
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID);
  }

  return payload;
}

function expiryDate(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/**
 * Starts a new token family. Called on every fresh sign-in, so each device gets
 * an independent chain and revoking one does not sign the user out everywhere.
 */
export async function issueTokenPair(
  userId: string,
  options: { deviceId?: string | null } = {},
): Promise<AuthTokens> {
  const familyId = randomUUID();
  return createTokenInFamily(userId, familyId, options.deviceId ?? null);
}

async function createTokenInFamily(
  userId: string,
  familyId: string,
  deviceId: string | null,
): Promise<AuthTokens> {
  const tokenId = randomUUID();
  const refreshToken = signRefreshToken(userId, tokenId, familyId);

  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      user_id: userId,
      family_id: familyId,
      token_hash: sha256(refreshToken),
      device_id: deviceId,
      expires_at: expiryDate(REFRESH_TTL_SECONDS),
    },
  });

  return {
    access_token: signAccessToken(userId),
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
  };
}

/** Revokes every live token in a family. Used on replay and on sign-out. */
export async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { family_id: familyId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

export async function revokeAllTokensForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/**
 * Exchanges a refresh token for a new pair.
 *
 * spec §4.3: rotate on every use and invalidate the old one. If a token that
 * has already been rotated comes back, treat it as theft and revoke the whole
 * family — the legitimate user and the attacker both hold tokens from that
 * chain, and there is no way to tell which is which, so neither may continue.
 */
export async function rotateRefreshToken(rawToken: string): Promise<AuthTokens> {
  const payload = verifyRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { token_hash: sha256(rawToken) },
  });

  if (!stored) {
    // Correctly signed but unknown to us: issued against a different secret, or
    // the row was purged. Either way it cannot be honoured.
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID);
  }

  if (stored.revoked_at || stored.replaced_by_id) {
    logger.warn(
      { user_id: stored.user_id, family_id: stored.family_id },
      'refresh token replay detected — revoking family',
    );
    await revokeFamily(stored.family_id);
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID);
  }

  if (stored.expires_at.getTime() <= Date.now()) {
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_EXPIRED);
  }

  const tokens = await createTokenInFamily(payload.sub, stored.family_id, stored.device_id);

  // Retire the presented token only after its successor exists, so a failure
  // mid-rotation cannot leave the user with no valid token at all.
  const successorId = verifyRefreshToken(tokens.refresh_token).jti;

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revoked_at: new Date(), replaced_by_id: successorId },
  });

  return tokens;
}

/**
 * Sign-out. Revokes the presented token's whole family, so that device is
 * logged out while other devices keep working.
 *
 * Never reveals whether the token was valid: sign-out succeeds regardless, and
 * a caller learning "that token was real" from an error would be a small oracle.
 */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const stored = await prisma.refreshToken.findUnique({
    where: { token_hash: sha256(rawToken) },
    select: { family_id: true },
  });

  if (stored) {
    await revokeFamily(stored.family_id);
  }
}

/** Housekeeping for the Batch 7 scheduler; harmless to call at any time. */
export async function pruneExpiredTokens(): Promise<number> {
  const result = await prisma.refreshToken.deleteMany({
    where: { expires_at: { lt: new Date() } },
  });
  return result.count;
}

export { generateSecureToken };
