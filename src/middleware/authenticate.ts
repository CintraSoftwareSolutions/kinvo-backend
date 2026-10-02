import type { Request, RequestHandler } from 'express';

import { UserStatus, prisma } from '@/db/prisma';
import { verifyAccessToken } from '@modules/auth/token.service';
import type { AccessTokenPayload, AuthenticatedUser } from '@modules/auth/auth.types';
import { isDeviceSignedOut } from '@modules/settings/devices.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

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

async function loadUser(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
  const [user, deviceSignedOut] = await Promise.all([
    prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: true,
        status: true,
        onboarded_at: true,
        deleted_at: true,
        suspension_reason: true,
      },
    }),
    payload.did ? isDeviceSignedOut(payload.sub, payload.did) : false,
  ]);

  if (!user || user.deleted_at || deviceSignedOut) {
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

  Promise.resolve()
    .then(async () => {
      req.user = await loadUser(verifyAccessToken(token));
    })
    .then(() => next())
    .catch(next);
};

export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req);

  if (!token) {
    next();
    return;
  }

  Promise.resolve()
    .then(async () => {
      req.user = await loadUser(verifyAccessToken(token));
    })
    .then(() => next())
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.code === ERROR_CODES.ACCOUNT_SUSPENDED) {
        next(error);
        return;
      }
      next();
    });
};
export function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new ApiError(ERROR_CODES.AUTH_REQUIRED);
  }
  return req.user;
}
