import { createPublicKey, type KeyObject } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '@config/env';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import type { SocialIdentity } from '@/providers/google-auth.provider';

/**
 * Sign in with Apple (spec §7, Batch 2).
 *
 * Apple publishes no Node SDK. The obvious JWKS libraries (`jose`, and
 * `jwks-rsa` which depends on it) ship ESM-only builds that the CommonJS test
 * runner cannot load, so this fetches Apple's key set directly instead.
 *
 * That turns out to be the better answer regardless: Apple's JWKS is a small,
 * stable JSON document, Node imports a JWK natively via `createPublicKey`, and
 * `jsonwebtoken` is already in the locked stack (§2). No new dependency, and
 * the caching behaviour is ours to control.
 *
 * Apple sends the user's name only on the very first authorisation and never
 * again — the app must capture it then and pass it through, which is why
 * display_name comes from the request rather than from the token.
 */

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`;

/** Apple rotates keys rarely; ten minutes keeps us current without hammering them. */
const KEY_CACHE_TTL_MS = 10 * 60 * 1000;

interface AppleJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface KeyCache {
  keys: Map<string, KeyObject>;
  fetched_at: number;
}

let cache: KeyCache | null = null;

/** Exported for tests; never call from application code. */
export function __clearAppleKeyCache(): void {
  cache = null;
}

async function fetchAppleKeys(): Promise<Map<string, KeyObject>> {
  const response = await fetch(APPLE_JWKS_URL, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Apple JWKS request failed with status ${response.status}`);
  }

  const body = (await response.json()) as { keys?: AppleJwk[] };
  const keys = new Map<string, KeyObject>();

  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) {
      continue;
    }
    keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
  }

  if (keys.size === 0) {
    throw new Error('Apple JWKS contained no usable keys');
  }

  cache = { keys, fetched_at: Date.now() };
  return keys;
}

async function getSigningKey(kid: string): Promise<KeyObject> {
  const isFresh = cache && Date.now() - cache.fetched_at < KEY_CACHE_TTL_MS;

  if (isFresh) {
    const cached = cache!.keys.get(kid);
    if (cached) {
      return cached;
    }
  }

  // Either the cache is stale, or Apple has rotated in a key we have not seen.
  // One refetch covers both; an unknown kid after that is a bad token.
  const keys = await fetchAppleKeys();
  const key = keys.get(kid);

  if (!key) {
    throw new Error(`Apple JWKS has no key for kid ${kid}`);
  }

  return key;
}

interface AppleIdTokenClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
}

/** Apple sends these booleans as the strings "true"/"false" in some versions. */
function asBoolean(value: boolean | string | undefined): boolean {
  return value === true || value === 'true';
}

export async function verifyAppleIdToken(idToken: string): Promise<SocialIdentity> {
  if (env.APPLE_CLIENT_IDS.length === 0) {
    throw new ApiError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'Apple sign-in is not available right now.',
    );
  }

  let claims: AppleIdTokenClaims;

  try {
    const decoded = jwt.decode(idToken, { complete: true });

    if (!decoded?.header.kid) {
      throw new Error('id token has no key id');
    }

    const key = await getSigningKey(decoded.header.kid);

    claims = jwt.verify(idToken, key, {
      issuer: APPLE_ISSUER,
      // Rejects a token minted for a different app — the difference between
      // "Apple signed this" and "Apple signed this for us".
      audience: env.APPLE_CLIENT_IDS as [string, ...string[]],
      algorithms: ['RS256'],
    }) as AppleIdTokenClaims;
  } catch (error) {
    logger.warn({ err: error }, 'apple id token verification failed');
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID, 'That Apple sign-in could not be verified.');
  }

  if (!claims.sub) {
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID, 'That Apple sign-in could not be verified.');
  }

  return {
    subject: claims.sub,
    email: claims.email ?? null,
    email_verified: asBoolean(claims.email_verified),
    name: null,
  };
}
