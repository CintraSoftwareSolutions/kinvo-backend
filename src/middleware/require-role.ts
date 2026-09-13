import type { RequestHandler } from 'express';

import type { UserRole } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * Role gate for admin and moderation routes (spec §7, Batch 15: RBAC enforced
 * on every admin route).
 *
 * Returns 403 FORBIDDEN rather than 404. Unlike a block — where a 404 hides
 * whether the resource exists (spec §4.4) — admin endpoints are a documented
 * part of the API, so there is nothing to conceal and a clear error is more
 * useful.
 *
 * Must be mounted after `authenticate`.
 */
export function requireRole(...allowed: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;

    if (!user) {
      next(new ApiError(ERROR_CODES.AUTH_REQUIRED));
      return;
    }

    if (!allowed.includes(user.role)) {
      next(new ApiError(ERROR_CODES.FORBIDDEN, 'You do not have access to this.'));
      return;
    }

    next();
  };
}
