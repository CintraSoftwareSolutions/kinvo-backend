import argon2 from 'argon2';

import { env, isTest } from '@config/env';
import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { generateSecureToken, sha256 } from '@utils/hash';

/**
 * Password hashing and reset tokens (spec §2, §7 Batch 2).
 */

/**
 * argon2id — the hybrid mode, resistant to both GPU and side-channel attacks.
 * These are the library defaults, stated explicitly so a future change is a
 * visible decision rather than a silent dependency upgrade.
 */
const PRODUCTION_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * Deliberately weak parameters, USED ONLY UNDER TEST.
 *
 * A production hash costs ~540ms by design; that cost IS the security property.
 * The suite hashes a password for nearly every fixture, which put roughly a
 * third of a fifteen-minute run inside argon2 — time that proves nothing, since
 * no test asserts how slow hashing is.
 *
 * These are the lowest values argon2 accepts. They are catastrophic for real
 * passwords, which is why the switch reads `isTest` and nothing else: there is
 * no environment variable to set wrong, and no way to reach them from a
 * deployed environment.
 */
const TEST_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 8192, // 8 MiB, the argon2 minimum for this parallelism
  timeCost: 2,
  parallelism: 1,
} as const;

const ARGON2_OPTIONS = isTest ? TEST_OPTIONS : PRODUCTION_OPTIONS;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Returns false rather than throwing on a malformed stored hash: a corrupt row
 * must read as "wrong password", never as a 500 that tells the caller the
 * account exists.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Runs a hash against a throwaway value so a login attempt for an unknown email
 * costs the same time as one for a real account. Without this, response timing
 * reveals which addresses are registered.
 */
export async function simulatePasswordVerification(): Promise<void> {
  await argon2.hash('timing-equalisation-placeholder', ARGON2_OPTIONS);
}

export interface ResetTokenIssue {
  /** Emailed to the user. Never stored. */
  token: string;
  expires_at: Date;
}

/**
 * spec §7 Batch 2: single-use, one-hour expiry.
 *
 * Any outstanding tokens are invalidated first — requesting a new reset must
 * retire the previous link, or an intercepted older email stays usable.
 */
export async function createPasswordResetToken(userId: string): Promise<ResetTokenIssue> {
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { user_id: userId, used_at: null },
      data: { used_at: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: { user_id: userId, token_hash: sha256(token), expires_at: expiresAt },
    }),
  ]);

  return { token, expires_at: expiresAt };
}

/**
 * Validates and consumes a reset token, returning the user it belongs to.
 *
 * Consumption is a conditional update rather than a read-then-write, so two
 * simultaneous requests cannot both succeed with the same token.
 */
export async function consumePasswordResetToken(rawToken: string): Promise<string> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { token_hash: sha256(rawToken) },
  });

  if (!stored || stored.used_at || stored.expires_at.getTime() <= Date.now()) {
    throw new ApiError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      'That reset link is no longer valid. Please request a new one.',
    );
  }

  const consumed = await prisma.passwordResetToken.updateMany({
    where: { id: stored.id, used_at: null },
    data: { used_at: new Date() },
  });

  if (consumed.count === 0) {
    throw new ApiError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      'That reset link is no longer valid. Please request a new one.',
    );
  }

  return stored.user_id;
}
