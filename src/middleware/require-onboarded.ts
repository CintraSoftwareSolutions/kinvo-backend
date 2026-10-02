import type { RequestHandler } from 'express';

import { UserStatus } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

export const requireOnboarded: RequestHandler = (req, _res, next) => {
  const user = req.user;

  if (!user) {
    next(new ApiError(ERROR_CODES.AUTH_REQUIRED));
    return;
  }

  if (user.status !== UserStatus.active || !user.is_onboarded) {
    next(
      new ApiError(
        ERROR_CODES.ONBOARDING_INCOMPLETE,
        'Finish setting up your profile to continue.',
        { status: user.status, is_onboarded: user.is_onboarded },
      ),
    );
    return;
  }

  next();
};
