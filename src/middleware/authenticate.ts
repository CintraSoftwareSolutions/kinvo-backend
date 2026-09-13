import type { Request, RequestHandler } from 'express';

import { UserStatus, prisma } from '@/db/prisma';
import { verifyAccessToken } from '@modules/auth/token.service';
import type { AuthenticatedUser } from '@modules/auth/auth.types';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * Bearer token authentication (spec §4.3).
 *
 * The three failure codes stay distinct because the app behaves differently for
 * each: AUTH_REQUIRED sends the user to sign-in, AUTH_TOKEN_EXPIRED triggers a
 * silent refresh and retry, AUTH_TOKEN_INVALID logs them out. A generic 401
 * forces the client to guess, and the usual guess is wrong for the middle case.
 */

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');

  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token.trim() || null;
}

/**
 * Loads the user on every request rather than trusting claims baked into the
 * token. An access token lives 30 minutes; a suspension, deletion, or completed
 * onboarding inside that window must take effect immediately, not when the
 * token happens to expire.
 */
async function loadUser(userId: string): Promise<AuthenticatedUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      status: true,
      onboarded_at: true,
      deleted_at: true,
      suspension_reason: true,
    },
  });

  // A token for a user who no longer exists is invalid, not "not found" — the
  // client should log out.
  if (!user || user.deleted_at) {
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID);
  }

  if (user.status === UserStatus.suspended) {
    throw new ApiError(
      ERROR_CODES.ACCOUNT_SUSPENDED,
      user.suspension_reason ?? 'Your account has been suspended.',
    );
  }

  return {
    id: user.id,
    role: user.role,
    status: user.status,
    is_onboarded: user.onboarded_at !== null,
  };
}

export const authenticate: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req);

  if (!token) {
    next(new ApiError(ERROR_CODES.AUTH_REQUIRED));
    return;
  }

  // verifyAccessToken throws AUTH_TOKEN_EXPIRED or AUTH_TOKEN_INVALID.
  Promise.resolve()
    .then(async () => {
      const payload = verifyAccessToken(token);
      req.user = await loadUser(payload.sub);
    })
    .then(() => next())
    .catch(next);
};

/**
 * Attaches the user when a valid token is present and does nothing otherwise.
 *
 * A bad token is ignored rather than rejected: these routes work for signed-out
 * callers, so a stale token should degrade to the anonymous experience rather
 * than turn a public page into an error.
 */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req);

  if (!token) {
    next();
    return;
  }

  Promise.resolve()
    .then(async () => {
      const payload = verifyAccessToken(token);
      req.user = await loadUser(payload.sub);
    })
    .then(() => next())
    .catch((error: unknown) => {
      // A suspension is still worth surfacing — it is not "merely signed out".
      if (error instanceof ApiError && error.code === ERROR_CODES.ACCOUNT_SUSPENDED) {
        next(error);
        return;
      }
      next();
    });
};

/**
 * Narrows `req.user` for handlers behind `authenticate`, so call sites do not
 * need a non-null assertion. Throwing here would mean the middleware chain was
 * assembled wrongly.
 */
export function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new ApiError(ERROR_CODES.AUTH_REQUIRED);
  }
  return req.user;
}
