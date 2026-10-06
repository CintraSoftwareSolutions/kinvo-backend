import { randomInt } from 'node:crypto';

import argon2 from 'argon2';

import { env, isTest } from '@config/env';
import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

const PRODUCTION_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

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

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function simulatePasswordVerification(): Promise<void> {
  await argon2.hash('timing-equalisation-placeholder', ARGON2_OPTIONS);
}

export interface ResetCodeIssue {
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
export function invalidResetCode(): ApiError {
  return new ApiError(
    ERROR_CODES.AUTH_TOKEN_INVALID,
    'That code is wrong or has expired. Please request a new one.',
  );
}
