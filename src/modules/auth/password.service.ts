import { randomInt } from 'node:crypto';

import argon2 from 'argon2';

import { env, isTest } from '@config/env';
import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * Password hashing and reset codes (spec §2, §7 Batch 2).
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

export interface ResetCodeIssue {
  /** Emailed to the user. Never stored, never logged. */
  code: string;
  expires_at: Date;
}

function generateResetCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export async function createPasswordResetCode(userId: string): Promise<ResetCodeIssue> {
  const code = generateResetCode();
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { user_id: userId, used_at: null },
      data: { used_at: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: { user_id: userId, token_hash: await hashPassword(code), expires_at: expiresAt },
    }),
  ]);

  return { code, expires_at: expiresAt };
}

/**
 * Validates and consumes a reset code.
 *
 * The code is looked up against ONE account — the one the email in the request
 * resolved to — never by hash across the table. Six digits collide across
 * users constantly, and a global lookup would let a caller who knows no email
 * address at all walk into whichever account happened to share their guess.
 *
 * Consumption is a conditional update rather than a read-then-write, so two
 * simultaneous requests cannot both succeed with the same code.
 */
export async function consumePasswordResetCode(userId: string, code: string): Promise<void> {
  const outstanding = await prisma.passwordResetToken.findFirst({
    where: {
      user_id: userId,
      used_at: null,
      expires_at: { gt: new Date() },
      attempts: { lt: env.PASSWORD_RESET_MAX_ATTEMPTS },
    },
    orderBy: { created_at: 'desc' },
  });

  if (!outstanding) {
    // Equalises the cost with a real verification below, so the response time
    // does not say whether a code is outstanding for this account.
    await simulatePasswordVerification();
    throw invalidResetCode();
  }

  if (!(await verifyPassword(outstanding.token_hash, code))) {
    const { attempts } = await prisma.passwordResetToken.update({
      where: { id: outstanding.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });

    // Out of guesses: destroy the code rather than leave it alive for the rest
    // of its hour. The user asks for a new one, which costs an attacker a
    // fresh email they cannot read.
    if (attempts >= env.PASSWORD_RESET_MAX_ATTEMPTS) {
      await prisma.passwordResetToken.updateMany({
        where: { id: outstanding.id, used_at: null },
        data: { used_at: new Date() },
      });
    }

    throw invalidResetCode();
  }

  const consumed = await prisma.passwordResetToken.updateMany({
    where: { id: outstanding.id, used_at: null },
    data: { used_at: new Date() },
  });

  if (consumed.count === 0) {
    throw invalidResetCode();
  }
}

/**
 * One message for every way a code can fail — wrong, expired, already used, out
 * of attempts, or never issued. Telling them apart tells a caller which
 * accounts have a reset in flight, and tells an attacker grinding codes whether
 * they are getting closer.
 */
export function invalidResetCode(): ApiError {
  return new ApiError(
    ERROR_CODES.AUTH_TOKEN_INVALID,
    'That code is wrong or has expired. Please request a new one.',
  );
}
