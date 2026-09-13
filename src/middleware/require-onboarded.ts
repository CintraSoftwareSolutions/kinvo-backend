import type { RequestHandler } from 'express';

import { UserStatus } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * spec §5.1: onboarding is a state machine, `pending -> active`. A pending user
 * is blocked from discovery, matching, and chat with ONBOARDING_INCOMPLETE.
 *
 * This is also the gate that makes social and phone signup safe: those accounts
 * are created without a date of birth, so they stay pending — and therefore
 * out of the product — until onboarding supplies one and the under-18 check
 * runs. Every discovery, matching, and chat route must sit behind this.
 *
 * Must be mounted after `authenticate`.
 */
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
