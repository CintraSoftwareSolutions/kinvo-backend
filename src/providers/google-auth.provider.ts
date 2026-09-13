import { OAuth2Client } from 'google-auth-library';

import { env } from '@config/env';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';

/**
 * Google Sign-In (spec §7, Batch 2).
 *
 * The app completes the Google flow and sends us the resulting ID token. We
 * verify it against Google's published keys before trusting a single field —
 * an unverified ID token is just a string the caller chose, and accepting one
 * would let anyone sign in as anyone.
 */

export interface SocialIdentity {
  /** The provider's stable subject identifier. Never the email. */
  subject: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
}

/**
 * iOS, Android, and web each have their own client ID, and all are legitimate
 * audiences for the same backend.
 */
const client = new OAuth2Client();

export async function verifyGoogleIdToken(idToken: string): Promise<SocialIdentity> {
  if (env.GOOGLE_OAUTH_CLIENT_IDS.length === 0) {
    throw new ApiError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'Google sign-in is not available right now.',
    );
  }

  let payload;

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      // Rejects a token minted for a different application, which is the
      // difference between "Google signed this" and "Google signed this for us".
      audience: env.GOOGLE_OAUTH_CLIENT_IDS,
    });
    payload = ticket.getPayload();
  } catch (error) {
    logger.warn({ err: error }, 'google id token verification failed');
    throw new ApiError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      'That Google sign-in could not be verified.',
    );
  }

  if (!payload?.sub) {
    throw new ApiError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      'That Google sign-in could not be verified.',
    );
  }

  return {
    subject: payload.sub,
    email: payload.email ?? null,
    email_verified: payload.email_verified === true,
    name: payload.name ?? null,
  };
}
