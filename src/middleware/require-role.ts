import type { RequestHandler } from 'express';

import type { UserRole } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

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
