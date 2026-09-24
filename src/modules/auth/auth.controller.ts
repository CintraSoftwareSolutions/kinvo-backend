import type { Request, Response } from 'express';

import { thirdPartyIntegrationsRequired } from '@config/env';
import { CLIENT_HEADERS } from '@config/constants';
import { requireUser } from '@middleware/authenticate';
import {
  type DeviceDetails,
  registerDevice,
  signOutDevice,
  touchDevice,
} from '@modules/settings/devices.service';
import { sendSuccess } from '@utils/response';
import type {
  ChangePasswordBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  ResetPasswordBody,
  SendOtpBody,
  SocialSignInBody,
  VerifyOtpBody,
} from './auth.schema';
import * as authService from './auth.service';
import * as otpService from './otp.service';
import * as socialService from './social.service';
import {
  issueTokenPair,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyAccessToken,
} from './token.service';

/**
 * Controllers translate between HTTP and the service layer. No business logic,
 * no database access (spec §0.5).
 */

/**
 * The device a sign-in comes from: the body's `device_id`, or else the header
 * the app sends with every request (spec §4.11).
 *
 * Resolved ONCE per sign-in and used for both the refresh token and the Device
 * row. They must be the same value. Revoking a device matches refresh tokens on
 * device_id, so if the Device row recorded the header while the token recorded
 * the body, revoking would match nothing, report success, and leave the session
 * alive — a security screen telling the user a comforting lie.
 */
function deviceIdFor(req: Request, bodyDeviceId: string | undefined): string | undefined {
  return bodyDeviceId ?? req.get(CLIENT_HEADERS.DEVICE_ID) ?? undefined;
}

/** A client header, trimmed and cut to the column it is stored in. */
function headerValue(req: Request, name: string, maxLength: number): string | undefined {
  const value = req.get(name)?.trim();
  return value ? value.slice(0, maxLength) : undefined;
}

/** What the request's headers say about the device (spec §4.11). */
function deviceDetails(req: Request, userId: string, deviceId: string): DeviceDetails {
  return {
    userId,
    deviceId,
    platform: req.get(CLIENT_HEADERS.PLATFORM) ?? 'web',
    // The column widths of the devices table.
    appVersion: headerValue(req, CLIENT_HEADERS.APP_VERSION, 32),
    osVersion: headerValue(req, CLIENT_HEADERS.OS_VERSION, 32),
    model: headerValue(req, CLIENT_HEADERS.DEVICE_MODEL, 64),
  };
}

/**
 * Records the device a session runs on, EVERY way a session starts.
 *
 * Push tokens can only be registered against a recorded device, and the device
 * list can only sign out what it lists. Recording it at log-in alone left every
 * account that signed up, or signed in with a phone number, Google, or Apple,
 * unable to receive a single push.
 *
 * Best effort: a failure recording the device must not fail the sign-in.
 */
async function recordDevice(
  req: Request,
  userId: string,
  deviceId: string | null | undefined,
): Promise<void> {
  if (!deviceId) {
    return;
  }

  await registerDevice(deviceDetails(req, userId, deviceId)).catch((error: unknown) =>
    req.log.warn({ err: error }, 'device registration failed'),
  );
}

export async function register(req: Request, res: Response): Promise<void> {
  const body = req.body as RegisterBody;
  const deviceId = deviceIdFor(req, body.device_id);

  const tokens = await authService.register({ ...body, device_id: deviceId });

  const userId = verifyAccessTokenSubject(tokens.access_token);
  if (userId) {
    await recordDevice(req, userId, deviceId);
  }

  sendSuccess(res, { ...tokens }, 201);
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = req.body as LoginBody;
  const deviceId = deviceIdFor(req, body.device_id);

  const tokens = await authService.login({ ...body, device_id: deviceId });

  const userId = verifyAccessTokenSubject(tokens.access_token);
  if (userId) {
    await recordDevice(req, userId, deviceId);
  }

  sendSuccess(res, { ...tokens });
}

/** The user id from a token we just minted; null rather than throwing. */
function verifyAccessTokenSubject(accessToken: string): string | null {
  try {
    return verifyAccessToken(accessToken).sub;
  } catch {
    return null;
  }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refresh_token: refreshToken } = req.body as RefreshBody;
  const session = await rotateRefreshToken(refreshToken);

  // Keeps the device's last-seen time and versions current, and records a
  // device for a session that started before every sign-in recorded one.
  // Best effort, like recording it at sign-in.
  if (session.deviceId) {
    await touchDevice(deviceDetails(req, session.userId, session.deviceId)).catch(
      (error: unknown) => req.log.warn({ err: error }, 'device update failed'),
    );
  }

  sendSuccess(res, { ...session.tokens });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { refresh_token: refreshToken } = req.body as RefreshBody;
  const session = await revokeRefreshToken(refreshToken);

  // A signed-out phone leaves the device list and stops receiving the
  // account's notifications. Left alone, it stays listed as signed in, and its
  // push token keeps message previews arriving on a device nobody is signed in
  // to. Best effort, like the rest of sign-out.
  if (session?.deviceId) {
    await signOutDevice(session.userId, session.deviceId).catch((error: unknown) =>
      req.log.warn({ err: error }, 'device sign-out failed'),
    );
  }

  // Always succeeds. Reporting "that token was not valid" would confirm to a
  // caller which tokens are real.
  sendSuccess(res, { signed_out: true });
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = req.body as { email: string };
  const request = await authService.requestPasswordReset(email);

  // The response never varies on whether the address is registered, or this
  // endpoint becomes an account-enumeration oracle.
  const payload: Record<string, unknown> = {
    message: 'If that address has an account, a reset code is on its way.',
  };

  // Nowhere to send it: local development, the test suite, and a staging box
  // with no mail account all run without a transport, and without this the
  // flow cannot be exercised there at all.
  //
  // The question is whether there is a transport AT ALL — not whether this
  // message was delivered. A transport that exists and failed answers
  // SERVICE_UNAVAILABLE from the service instead of reaching here, and one
  // that refuses a single recipient says nothing at all: handing the code
  // back in either case would be a password reset anybody can complete for
  // anybody whose address the mail server happens to dislike.
  //
  // The waiver stays as the second lock: real production refuses to boot
  // without a transport (config/env.ts), and `thirdPartyIntegrationsRequired`
  // is what tells production from staging — `isProduction` alone does not,
  // because staging runs with NODE_ENV=production on purpose.
  if (request && !thirdPartyIntegrationsRequired && request.hasNowhereToSend) {
    payload.reset_code = request.code;
  }

  sendSuccess(res, payload);
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { email, code, password } = req.body as ResetPasswordBody;
  await authService.resetPassword(email, code, password);
  sendSuccess(res, { password_reset: true });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as ChangePasswordBody;

  await authService.changePassword(user.id, body.current_password, body.new_password);
  sendSuccess(res, { password_changed: true });
}

export async function sendOtp(req: Request, res: Response): Promise<void> {
  const { phone } = req.body as SendOtpBody;
  await otpService.sendOtp(phone);

  // Identical whether or not the number is registered.
  sendSuccess(res, { sent: true });
}

export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const body = req.body as VerifyOtpBody;
  const result = await otpService.verifyOtp(body.phone, body.code, body.display_name);
  const deviceId = deviceIdFor(req, body.device_id);
  const tokens = await issueTokenPair(result.user_id, { deviceId: deviceId ?? null });
  await recordDevice(req, result.user_id, deviceId);

  sendSuccess(res, { ...tokens, is_new_user: result.is_new_user }, result.is_new_user ? 201 : 200);
}

export async function googleSignIn(req: Request, res: Response): Promise<void> {
  const body = req.body as SocialSignInBody;
  const result = await socialService.signInWithGoogle(body.id_token, body.display_name);
  const deviceId = deviceIdFor(req, body.device_id);
  const tokens = await issueTokenPair(result.user_id, { deviceId: deviceId ?? null });
  await recordDevice(req, result.user_id, deviceId);

  sendSuccess(res, { ...tokens, is_new_user: result.is_new_user }, result.is_new_user ? 201 : 200);
}

export async function appleSignIn(req: Request, res: Response): Promise<void> {
  const body = req.body as SocialSignInBody;
  const result = await socialService.signInWithApple(body.id_token, body.display_name);
  const deviceId = deviceIdFor(req, body.device_id);
  const tokens = await issueTokenPair(result.user_id, { deviceId: deviceId ?? null });
  await recordDevice(req, result.user_id, deviceId);

  sendSuccess(res, { ...tokens, is_new_user: result.is_new_user }, result.is_new_user ? 201 : 200);
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const profile = await authService.getAuthenticatedUser(user.id);
  sendSuccess(res, { ...profile });
}
