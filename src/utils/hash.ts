import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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
