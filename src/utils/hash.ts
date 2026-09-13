import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hashing for high-entropy secrets — refresh tokens and password-reset tokens.
 *
 * SHA-256, deliberately, not argon2. Argon2 is slow on purpose to make a
 * low-entropy human password expensive to guess. These values are 256 bits of
 * randomness, so there is nothing to guess; a slow hash would only add latency
 * to every token refresh.
 *
 * They are still hashed at rest: a leaked database must not hand the attacker
 * usable tokens.
 */

/** 32 bytes of randomness, URL-safe. */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison, so a match cannot be found one character at a time. */
export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}
