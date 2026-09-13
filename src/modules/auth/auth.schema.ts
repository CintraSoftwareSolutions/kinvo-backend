import { z } from 'zod';

/**
 * Zod schemas for every auth endpoint (spec §0.5: validate before business
 * logic). Messages are user-displayable — they surface directly in the
 * VALIDATION_FAILED details keyed by field (spec §4.2).
 */

const email = z
  .string({ required_error: 'Enter your email address.' })
  .trim()
  .min(1, 'Enter your email address.')
  .max(320, 'That email address is too long.')
  .email('Enter a valid email address.');

/**
 * Length only. Composition rules (a digit, a symbol, a capital) push people
 * toward predictable substitutions and shorter passwords; length is the term
 * that actually matters. 72 bytes is bcrypt's ceiling — argon2 has no such
 * limit, but capping keeps a future algorithm swap from silently truncating.
 */
const password = z
  .string({ required_error: 'Enter a password.' })
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Passwords can be at most 72 characters.');

const displayName = z
  .string({ required_error: 'Enter your name.' })
  .trim()
  .min(1, 'Enter your name.')
  .max(50, 'Names can be at most 50 characters.');

/** spec §4.6: dates are YYYY-MM-DD. The 18+ check runs in the service. */
const dateOfBirth = z
  .string({ required_error: 'Enter your date of birth.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()), {
    message: 'Enter a valid date.',
  });

/** E.164 — the only format Twilio accepts. */
const phone = z
  .string({ required_error: 'Enter your phone number.' })
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Enter a phone number in international format, e.g. +447700900123.');

const deviceId = z.string().trim().max(128).optional();

export const registerSchema = z.object({
  email,
  password,
  display_name: displayName,
  date_of_birth: dateOfBirth,
  device_id: deviceId,
});

export const loginSchema = z.object({
  email,
  password: z.string({ required_error: 'Enter your password.' }).min(1, 'Enter your password.'),
  device_id: deviceId,
});

export const refreshSchema = z.object({
  refresh_token: z
    .string({ required_error: 'A refresh token is required.' })
    .min(1, 'A refresh token is required.'),
});

export const logoutSchema = refreshSchema;

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z
    .string({ required_error: 'A reset token is required.' })
    .min(1, 'A reset token is required.'),
  password,
});

export const changePasswordSchema = z.object({
  current_password: z
    .string({ required_error: 'Enter your current password.' })
    .min(1, 'Enter your current password.'),
  new_password: password,
});

export const sendOtpSchema = z.object({ phone });

export const verifyOtpSchema = z.object({
  phone,
  code: z
    .string({ required_error: 'Enter the code we sent you.' })
    .trim()
    .regex(/^\d{4,10}$/, 'Enter the code we sent you.'),
  display_name: displayName.optional(),
  device_id: deviceId,
});

const socialSignIn = z.object({
  id_token: z
    .string({ required_error: 'An identity token is required.' })
    .min(1, 'An identity token is required.'),
  /**
   * Apple sends the user's name only on the very first authorisation and never
   * again, so the app captures it then and passes it here.
   */
  display_name: displayName.optional(),
  device_id: deviceId,
});

export const googleSignInSchema = socialSignIn;
export const appleSignInSchema = socialSignIn;

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
export type SendOtpBody = z.infer<typeof sendOtpSchema>;
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>;
export type SocialSignInBody = z.infer<typeof socialSignIn>;
