import { UserStatus, prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { assertAdult, calculateAge } from '@utils/age';
import { logger } from '@utils/logger';
import type { AuthMeResponse, AuthTokens } from './auth.types';
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  hashPassword,
  simulatePasswordVerification,
  verifyPassword,
} from './password.service';
import { issueTokenPair, revokeAllTokensForUser } from './token.service';

/**
 * Account lifecycle: registration, sign-in, and password management.
 *
 * Token mechanics live in token.service, social linking in social.service, and
 * OTP in otp.service. This module owns who is allowed to become a user and who
 * is allowed in.
 */

/** Stored lower-cased so the same address cannot register twice by casing. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface RegisterInput {
  email: string;
  password: string;
  display_name: string;
  date_of_birth: string;
  device_id?: string;
}

export async function register(input: RegisterInput): Promise<AuthTokens> {
  const email = normaliseEmail(input.email);
  const dateOfBirth = new Date(`${input.date_of_birth}T00:00:00Z`);

  // spec §5.1: reject under-18 at registration. Checked before anything is
  // written, so a rejected signup leaves nothing behind.
  assertAdult(dateOfBirth);

  const existing = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider: 'email', identifier: email } },
    select: { id: true, password_hash: true, user_id: true },
  });

  if (existing) {
    // ACCOUNT TAKEOVER GUARD — do not "helpfully" attach a password here.
    //
    // Social sign-in records the user's verified address as an email identity
    // with no password, so that a later Google or Apple sign-in links rather
    // than duplicating (spec §5.1). An earlier version of this method treated
    // that empty password as an invitation to set one and returned tokens.
    // That handed the account to anyone who knew the address: no mailbox proof,
    // no verification, nothing.
    //
    // Registration therefore always refuses an address that is already here.
    // The legitimate route to a first password on a social account is
    // forgot-password, which requires control of the mailbox.
    throw new ApiError(
      ERROR_CODES.CONFLICT,
      'An account with that email already exists. Try signing in, or reset your password.',
    );
  }

  const user = await prisma.user.create({
    data: {
      display_name: input.display_name.trim(),
      date_of_birth: dateOfBirth,
      // spec §5.1: onboarding is a state machine. A `pending` user is blocked
      // from discovery, matching, and chat until Batch 3 completes their profile.
      status: UserStatus.pending,
      auth_identities: {
        create: {
          provider: 'email',
          identifier: email,
          password_hash: await hashPassword(input.password),
        },
      },
    },
    select: { id: true },
  });

  return issueTokenPair(user.id, { deviceId: input.device_id });
}

export interface LoginInput {
  email: string;
  password: string;
  device_id?: string;
}

export async function login(input: LoginInput): Promise<AuthTokens> {
  const email = normaliseEmail(input.email);

  const identity = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider: 'email', identifier: email } },
    select: {
      password_hash: true,
      user: { select: { id: true, status: true, deleted_at: true, suspension_reason: true } },
    },
  });

  // One message and one timing profile for "no such account" and "wrong
  // password". Anything else lets an attacker enumerate registered addresses.
  if (!identity?.password_hash) {
    await simulatePasswordVerification();
    throw new ApiError(ERROR_CODES.AUTH_INVALID_CREDENTIALS);
  }

  const isCorrect = await verifyPassword(identity.password_hash, input.password);

  if (!isCorrect || identity.user.deleted_at) {
    throw new ApiError(ERROR_CODES.AUTH_INVALID_CREDENTIALS);
  }

  if (identity.user.status === UserStatus.suspended) {
    throw new ApiError(
      ERROR_CODES.ACCOUNT_SUSPENDED,
      identity.user.suspension_reason ?? 'Your account has been suspended.',
    );
  }

  await prisma.user.update({
    where: { id: identity.user.id },
    data: { last_active_at: new Date() },
  });

  return issueTokenPair(identity.user.id, { deviceId: input.device_id });
}

/**
 * spec §7 Batch 2: password reset tokens are single-use with a one-hour expiry.
 *
 * Returns the token so the caller can email it (Batch 11 wires the mailer). The
 * endpoint's response never varies on whether the address exists.
 */
export async function requestPasswordReset(rawEmail: string): Promise<string | null> {
  const email = normaliseEmail(rawEmail);

  const identity = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider: 'email', identifier: email } },
    select: { user: { select: { id: true, deleted_at: true } } },
  });

  if (!identity || identity.user.deleted_at) {
    return null;
  }

  const { token } = await createPasswordResetToken(identity.user.id);
  return token;
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const userId = await consumePasswordResetToken(rawToken);

  const identity = await prisma.authIdentity.findFirst({
    where: { user_id: userId, provider: 'email' },
    select: { id: true },
  });

  if (!identity) {
    throw new ApiError(ERROR_CODES.AUTH_TOKEN_INVALID, 'That reset link is no longer valid.');
  }

  await prisma.authIdentity.update({
    where: { id: identity.id },
    data: { password_hash: await hashPassword(newPassword) },
  });

  // A reset usually means the account was compromised, so every existing
  // session dies with it. The user signs in again with the new password.
  await revokeAllTokensForUser(userId);

  logger.info({ user_id: userId }, 'password reset completed, all sessions revoked');
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const identity = await prisma.authIdentity.findFirst({
    where: { user_id: userId, provider: 'email' },
    select: { id: true, password_hash: true },
  });

  if (!identity?.password_hash) {
    throw new ApiError(
      ERROR_CODES.BAD_REQUEST,
      'This account does not sign in with a password. Use forgot password to set one.',
    );
  }

  if (!(await verifyPassword(identity.password_hash, currentPassword))) {
    throw new ApiError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 'Your current password is incorrect.');
  }

  await prisma.authIdentity.update({
    where: { id: identity.id },
    data: { password_hash: await hashPassword(newPassword) },
  });

  await revokeAllTokensForUser(userId);
}

export async function getAuthenticatedUser(userId: string): Promise<AuthMeResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      display_name: true,
      date_of_birth: true,
      status: true,
      role: true,
      is_verified: true,
      subscription_tier: true,
      onboarded_at: true,
      created_at: true,
      auth_identities: {
        select: { provider: true, identifier: true, verified_at: true },
        orderBy: { created_at: 'asc' },
      },
    },
  });

  if (!user) {
    throw ApiError.notFound();
  }

  return {
    id: user.id,
    display_name: user.display_name,
    // spec §4.6: YYYY-MM-DD for dates, null rather than an omitted key.
    date_of_birth: user.date_of_birth ? user.date_of_birth.toISOString().slice(0, 10) : null,
    age: user.date_of_birth ? calculateAge(user.date_of_birth) : null,
    status: user.status,
    role: user.role,
    is_verified: user.is_verified,
    is_onboarded: user.onboarded_at !== null,
    subscription_tier: user.subscription_tier,
    identities: user.auth_identities.map((identity) => ({
      provider: identity.provider,
      identifier: identity.identifier,
      is_verified: identity.verified_at !== null,
    })),
    created_at: user.created_at.toISOString(),
  };
}
