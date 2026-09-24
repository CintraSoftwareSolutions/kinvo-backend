import { UserStatus, prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { assertAdult, calculateAge } from '@utils/age';
import { logger } from '@utils/logger';
import type { AuthMeResponse, AuthTokens } from './auth.types';
import { getEmailProvider } from '@modules/notifications/providers';
import type { EmailProvider } from '@/providers/email.provider';
import { signOutAllDevices } from '@modules/settings/devices.service';
import { passwordResetEmail } from './auth.emails';
import {
  consumePasswordResetCode,
  createPasswordResetCode,
  hashPassword,
  invalidResetCode,
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

export interface PasswordResetRequest {
  code: string;
  /**
   * Whether this deployment has nowhere to send it — no mail transport at all,
   * as on a developer's machine and in CI. The ONLY case where the code may be
   * handed back to whoever asked.
   *
   * Not "it was not delivered": a provider that refuses one recipient has not
   * delivered it either, and handing the code back then would mean anybody
   * could have a reset code for any address the mail server happens to dislike.
   */
  hasNowhereToSend: boolean;
}

/**
 * Refuses while the mail transport is known to be down.
 *
 * Only where a transport is configured at all: local development, CI, and a
 * staging box with no mail account run on the no-op provider, where the code
 * comes back in the response instead so the flow stays exercisable. A
 * deployment that HAS a transport gets the honest answer, staging included —
 * handing the code to the caller because email is broken would turn a password
 * reset into one anybody can complete for anybody.
 */
function assertEmailTransportUsable(transport: EmailProvider): void {
  if (transport.isConfigured && !transport.isReady) {
    throw new ApiError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'We cannot send email at the moment. Please try again shortly.',
    );
  }
}

export async function requestPasswordReset(rawEmail: string): Promise<PasswordResetRequest | null> {
  const email = normaliseEmail(rawEmail);
  const transport = getEmailProvider();

  // Checked BEFORE the address is looked up, and so before anything here knows
  // whether it belongs to an account. An outage reported only to addresses that
  // exist is an enumeration oracle wearing a 503, and refusing that question is
  // the whole point of this endpoint.
  assertEmailTransportUsable(transport);

  const identity = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider: 'email', identifier: email } },
    select: { user: { select: { id: true, deleted_at: true } } },
  });

  if (!identity || identity.user.deleted_at) {
    await simulatePasswordVerification();
    return null;
  }

  const { code } = await createPasswordResetCode(identity.user.id);

  const delivery = await transport.send(passwordResetEmail(email, code));

  logger.info(
    { user_id: identity.user.id, delivery: delivery.status },
    'password reset code issued',
  );

  // A refused RECIPIENT is never reported — whether an address can receive mail
  // is a fact about the address, and this endpoint answers nothing about
  // addresses. A refused TRANSPORT is reported, because it is a fact about us,
  // and "a reset code is on its way" when the transport just refused it is how
  // staging spent its first weeks sending people to an inbox nothing had been
  // sent to.
  //
  // This message is the one that discovered the outage, so the check above
  // could not have caught it, and for this single request the refusal does
  // depend on an account existing. It closes behind itself: the failure is now
  // recorded, so every request after it — registered or not — is refused the
  // same way until the transport recovers.
  if (delivery.status === 'unavailable') {
    assertEmailTransportUsable(transport);
  }

  return { code, hasNowhereToSend: !transport.isConfigured };
}

export async function resetPassword(
  rawEmail: string,
  code: string,
  newPassword: string,
): Promise<void> {
  const email = normaliseEmail(rawEmail);

  const identity = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider: 'email', identifier: email } },
    select: { id: true, user: { select: { id: true, deleted_at: true } } },
  });

  // An address with no account fails exactly as a wrong code does, at the same
  // cost, or this endpoint answers the question forgot-password refuses to.
  if (!identity || identity.user.deleted_at) {
    await simulatePasswordVerification();
    throw invalidResetCode();
  }

  await consumePasswordResetCode(identity.user.id, code);

  await prisma.authIdentity.update({
    where: { id: identity.id },
    data: { password_hash: await hashPassword(newPassword) },
  });

  // A reset usually means the account was compromised, so every existing
  // session dies with it. The user signs in again with the new password.
  await revokeAllTokensForUser(identity.user.id);
  await signOutAllDevices(identity.user.id);

  logger.info({ user_id: identity.user.id }, 'password reset completed, all sessions revoked');
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
  await signOutAllDevices(userId);
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
