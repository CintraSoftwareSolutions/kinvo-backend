import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import {
  loginRateLimit,
  otpSendRateLimit,
  otpVerifyRateLimit,
  passwordResetConfirmRateLimit,
  passwordResetRateLimit,
  refreshRateLimit,
  registerRateLimit,
  socialSignInRateLimit,
} from '@middleware/rate-limit';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './auth.controller';
import {
  appleSignInSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  googleSignInSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from './auth.schema';

/**
 * Auth routes (spec §7, Batch 2).
 *
 * Rate limits sit on the endpoints that are attacked or that cost money:
 * sign-in (credential stuffing), registration (bulk account creation), OTP
 * (each SMS is billed), and password reset (mailbox flooding). These are
 * infrastructure limits returning 429 — never business quotas (spec §4.9).
 */
export const authRouter: Router = Router();

authRouter.post(
  '/register',
  registerRateLimit,
  validate({ body: registerSchema }),
  asyncHandler(controller.register),
);

authRouter.post(
  '/login',
  loginRateLimit,
  validate({ body: loginSchema }),
  asyncHandler(controller.login),
);

authRouter.post(
  '/refresh',
  refreshRateLimit,
  validate({ body: refreshSchema }),
  asyncHandler(controller.refresh),
);

authRouter.post('/logout', validate({ body: logoutSchema }), asyncHandler(controller.logout));

authRouter.post(
  '/forgot-password',
  passwordResetRateLimit,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(controller.forgotPassword),
);

authRouter.post(
  '/reset-password',
  passwordResetConfirmRateLimit,
  validate({ body: resetPasswordSchema }),
  asyncHandler(controller.resetPassword),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  asyncHandler(controller.changePassword),
);

authRouter.post(
  '/otp/send',
  otpSendRateLimit,
  validate({ body: sendOtpSchema }),
  asyncHandler(controller.sendOtp),
);

authRouter.post(
  '/otp/verify',
  otpVerifyRateLimit,
  validate({ body: verifyOtpSchema }),
  asyncHandler(controller.verifyOtp),
);

authRouter.post(
  '/google',
  socialSignInRateLimit,
  validate({ body: googleSignInSchema }),
  asyncHandler(controller.googleSignIn),
);

authRouter.post(
  '/apple',
  socialSignInRateLimit,
  validate({ body: appleSignInSchema }),
  asyncHandler(controller.appleSignIn),
);

authRouter.get('/me', authenticate, asyncHandler(controller.me));
