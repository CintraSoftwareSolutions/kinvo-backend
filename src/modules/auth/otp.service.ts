import { UserStatus, prisma } from '@/db/prisma';
import { getOtpProvider } from '@/providers/twilio.provider';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * Phone OTP via Twilio Verify (spec §2, §7 Batch 2).
 *
 * Twilio owns the code — generation, storage, expiry, and attempt counting all
 * happen there, so no OTP secret ever touches our database.
 *
 * Like social sign-in, a phone number carries no date of birth. A new number
 * therefore creates a `pending` account, blocked from the product until Batch
 * 3's onboarding supplies a date of birth and applies the under-18 rejection.
 */

export interface OtpVerifyResult {
  user_id: string;
  is_new_user: boolean;
}

/**
 * Sends a code.
 *
 * Deliberately does not reveal whether the number is registered — the response
 * is identical either way, so this cannot be used to enumerate users.
 */
export async function sendOtp(phone: string): Promise<void> {
  await getOtpProvider().sendCode(phone);
}

export async function verifyOtp(
  phone: string,
  code: string,
  displayName?: string,
): Promise<OtpVerifyResult> {
  const result = await getOtpProvider().checkCode(phone, code);

  if (!result.valid) {
    throw new ApiError(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      'That code is incorrect or has expired.',
    );
  }

  const existing = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider: 'phone', identifier: phone } },
    select: { id: true, user_id: true },
  });

  if (existing) {
    // A successful check is proof of possession, so the number is now verified
    // even if it was added but never confirmed.
    await prisma.authIdentity.update({
      where: { id: existing.id },
      data: { verified_at: new Date() },
    });

    return { user_id: existing.user_id, is_new_user: false };
  }

  const user = await prisma.user.create({
    data: {
      display_name: displayName?.trim().slice(0, 50) || 'New user',
      date_of_birth: null,
      status: UserStatus.pending,
      auth_identities: {
        create: { provider: 'phone', identifier: phone, verified_at: new Date() },
      },
    },
    select: { id: true },
  });

  return { user_id: user.id, is_new_user: true };
}

/**
 * Attaches a verified phone number to an account that already exists.
 * Used by the settings flow rather than sign-in.
 */
export async function attachVerifiedPhone(
  userId: string,
  phone: string,
  code: string,
): Promise<void> {
  const result = await getOtpProvider().checkCode(phone, code);

  if (!result.valid) {
    throw new ApiError(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      'That code is incorrect or has expired.',
    );
  }

  const existing = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider: 'phone', identifier: phone } },
    select: { user_id: true },
  });

  if (existing && existing.user_id !== userId) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That number is already in use on another account.');
  }

  await prisma.authIdentity.upsert({
    where: { provider_identifier: { provider: 'phone', identifier: phone } },
    create: { user_id: userId, provider: 'phone', identifier: phone, verified_at: new Date() },
    update: { verified_at: new Date() },
  });
}
