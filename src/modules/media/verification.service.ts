import { MediaKind, VerificationMethod, VerificationStatus, prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { claimAsset } from './media.service';
import type { VerificationView } from './media.types';

/**
 * Identity verification (spec §7, Batch 4).
 *
 * Three methods, a three-step wizard, `pending -> approved | rejected`, and the
 * badge derived from the latest approved record rather than stored as a
 * free-standing flag.
 *
 * Documents go to the verification bucket, never the media bucket. Government
 * ID images are the most sensitive data in this system: a separate bucket means
 * a separate policy, a separate lifecycle, and a much shorter URL lifetime, and
 * none of that can be undone by someone editing the photo bucket's config.
 *
 * The verification badge matters beyond a tick on a profile: `verified_only` is
 * a hard discovery filter (spec §5.3), verified users rank higher in the deck,
 * and from Batch 5 enabling Cuddle mode is expected to require it.
 */

/** submit -> upload document -> confirm. Reported so the app can render progress. */
export const TOTAL_STEPS = 3;

const METHODS: VerificationMethod[] = [
  VerificationMethod.photo,
  VerificationMethod.government_id,
  VerificationMethod.social,
];

function toView(
  record: {
    id: string;
    method: VerificationMethod;
    status: VerificationStatus;
    current_step: number;
    submitted_at: Date | null;
    reviewed_at: Date | null;
    rejection_reason: string | null;
  } | null,
  isVerified: boolean,
): VerificationView {
  if (!record) {
    return {
      id: null,
      method: null,
      status: 'not_started',
      current_step: 0,
      total_steps: TOTAL_STEPS,
      submitted_at: null,
      reviewed_at: null,
      rejection_reason: null,
      is_verified: isVerified,
    };
  }

  return {
    id: record.id,
    method: record.method,
    status: record.status,
    current_step: record.current_step,
    total_steps: TOTAL_STEPS,
    submitted_at: record.submitted_at?.toISOString() ?? null,
    reviewed_at: record.reviewed_at?.toISOString() ?? null,
    // Only ever populated on the user's own record; never exposed to others.
    rejection_reason: record.rejection_reason,
    is_verified: isVerified,
  };
}

/**
 * The badge, derived rather than trusted.
 *
 * `users.is_verified` is a denormalised copy kept for the deck's hard filter and
 * ranking; this is the source of truth that keeps it honest.
 */
export async function hasApprovedVerification(userId: string): Promise<boolean> {
  const approved = await prisma.verification.findFirst({
    where: { user_id: userId, status: VerificationStatus.approved },
    select: { id: true },
  });

  return approved !== null;
}

/** Recomputes the denormalised flag from the records. */
export async function refreshVerifiedFlag(userId: string): Promise<boolean> {
  const isVerified = await hasApprovedVerification(userId);

  await prisma.user.update({
    where: { id: userId },
    data: { is_verified: isVerified },
  });

  return isVerified;
}

export async function getVerificationStatus(userId: string): Promise<VerificationView> {
  const latest = await prisma.verification.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
  });

  return toView(latest, await hasApprovedVerification(userId));
}

/**
 * Step 1 — start a verification attempt.
 *
 * Refuses a second attempt while one is already awaiting review, so a user
 * cannot flood the moderation queue by tapping repeatedly.
 */
export async function startVerification(
  userId: string,
  method: VerificationMethod,
): Promise<VerificationView> {
  if (!METHODS.includes(method)) {
    throw ApiError.validation({ method: ['Choose a supported verification method.'] });
  }

  if (await hasApprovedVerification(userId)) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'Your account is already verified.');
  }

  const pending = await prisma.verification.findFirst({
    where: { user_id: userId, status: VerificationStatus.pending },
    select: { id: true },
  });

  if (pending) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'You already have a verification in progress.');
  }

  const record = await prisma.verification.create({
    data: { user_id: userId, method, status: VerificationStatus.pending, current_step: 1 },
  });

  logger.info({ user_id: userId, method }, 'verification started');

  return toView(record, false);
}

/**
 * Step 2 — attach the document.
 *
 * `claimAsset` enforces that the upload belongs to the caller, finished, and is
 * of kind `verification_document`, which by policy lives in the verification
 * bucket. A profile photo cannot be submitted as an ID.
 */
export async function attachVerificationDocument(
  userId: string,
  verificationId: string,
  uploadId: string,
): Promise<VerificationView> {
  const record = await prisma.verification.findFirst({
    where: { id: verificationId, user_id: userId },
  });

  if (!record) {
    throw ApiError.notFound('That verification does not exist.');
  }

  if (record.status !== VerificationStatus.pending) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That verification has already been reviewed.');
  }

  const asset = await claimAsset({
    userId,
    assetId: uploadId,
    expectedKind: MediaKind.verification_document,
  });

  const updated = await prisma.verification.update({
    where: { id: record.id },
    data: { asset_id: asset.id, current_step: 2 },
  });

  return toView(updated, false);
}

/**
 * Step 3 — submit for review.
 *
 * The `social` method carries no document, so it may submit without one; the
 * other two may not.
 */
export async function submitVerification(
  userId: string,
  verificationId: string,
): Promise<VerificationView> {
  const record = await prisma.verification.findFirst({
    where: { id: verificationId, user_id: userId },
  });

  if (!record) {
    throw ApiError.notFound('That verification does not exist.');
  }

  if (record.status !== VerificationStatus.pending) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That verification has already been reviewed.');
  }

  if (record.method !== VerificationMethod.social && !record.asset_id) {
    throw new ApiError(ERROR_CODES.BAD_REQUEST, 'Upload your document before submitting.');
  }

  const updated = await prisma.verification.update({
    where: { id: record.id },
    data: { current_step: TOTAL_STEPS, submitted_at: new Date() },
  });

  logger.info({ user_id: userId, verification_id: record.id }, 'verification submitted for review');

  return toView(updated, false);
}

/**
 * Moderator decision. Batch 15 puts an admin endpoint in front of this; the
 * transition lives here so the badge can never drift from the records.
 */
export async function reviewVerification(options: {
  verificationId: string;
  reviewerId: string;
  approve: boolean;
  rejectionReason?: string;
}): Promise<VerificationView> {
  const record = await prisma.verification.findUnique({
    where: { id: options.verificationId },
  });

  if (!record) {
    throw ApiError.notFound('That verification does not exist.');
  }

  if (record.status !== VerificationStatus.pending) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That verification has already been reviewed.');
  }

  const updated = await prisma.verification.update({
    where: { id: record.id },
    data: {
      status: options.approve ? VerificationStatus.approved : VerificationStatus.rejected,
      reviewed_at: new Date(),
      reviewed_by_id: options.reviewerId,
      rejection_reason: options.approve ? null : (options.rejectionReason ?? null),
    },
  });

  const isVerified = await refreshVerifiedFlag(record.user_id);

  logger.info(
    { user_id: record.user_id, verification_id: record.id, approved: options.approve },
    'verification reviewed',
  );

  return toView(updated, isVerified);
}
