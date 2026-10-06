import {
  MediaKind,
  type Prisma,
  VerificationMethod,
  VerificationStatus,
  prisma,
} from '@/db/prisma';
import { type BucketName, presignDownload } from '@/providers/s3.provider';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { notify } from '@modules/notifications/notifications.service';
import { getPrimaryPhotoUrlsFor } from './photos.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { claimAsset } from './media.service';
import type { VerificationView } from './media.types';

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
export async function hasApprovedVerification(userId: string): Promise<boolean> {
  const approved = await prisma.verification.findFirst({
    where: { user_id: userId, status: VerificationStatus.approved },
    select: { id: true },
  });

  return approved !== null;
}

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

export async function reviewVerification(options: {
  verificationId: string;
  reviewerId: string;
  approve: boolean;
  rejectionReason?: string;
  ipAddress?: string | null;
}): Promise<VerificationView> {
  const record = await prisma.verification.findUnique({
    where: { id: options.verificationId },
  });

  if (!record) {
    throw ApiError.notFound('That verification does not exist.');
  }

  if (record.status !== VerificationStatus.pending) {
    // Two reviewers opening the same queue is the normal case, not an edge
    // one. A second decision must fail loudly rather than silently overwrite
    // the first — and the 409 is what tells the panel to refresh.
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

  try {
    await prisma.adminAuditLog.create({
      data: {
        admin_id: options.reviewerId,
        action: options.approve ? 'verification.approve' : 'verification.reject',
        target_type: 'verification',
        target_id: record.id,
        metadata: {
          subject_user_id: record.user_id,
          method: record.method,
          // The reason is stored on the record too; keeping it here means the
          // audit trail stands alone if the record is ever amended.
          rejection_reason: options.approve ? null : (options.rejectionReason ?? null),
        },
        ip_address: options.ipAddress ?? null,
      },
    });
  } catch (error) {
    logger.error({ err: error, verification_id: record.id }, 'failed to write admin audit log');
  }

  await notify({
    userId: record.user_id,
    category: 'verification',
    title: options.approve ? 'You are verified' : 'Verification not approved',
    body: options.approve
      ? 'Your verified badge is now on your profile.'
      : (options.rejectionReason ?? 'Please check your details and try again.'),
    data: { verification_id: record.id, approved: options.approve },
  });

  logger.info(
    { user_id: record.user_id, verification_id: record.id, approved: options.approve },
    'verification reviewed',
  );

  return toView(updated, isVerified);
}

// ---------------------------------------------------------------------------
// Review side (admin / moderator)
// ---------------------------------------------------------------------------

export interface VerificationReviewItem {
  id: string;
  status: VerificationStatus;
  method: VerificationMethod;
  submitted_at: string | null;
  created_at: string;
  user: UserCompact;
  document_url: string | null;
  social_provider: string | null;
}

const REVIEW_INCLUDE = {
  user: { select: USER_COMPACT_SELECT },
  asset: { select: { s3_bucket: true, s3_key: true, uploaded_at: true } },
} satisfies Prisma.VerificationInclude;

type ReviewRow = Prisma.VerificationGetPayload<{ include: typeof REVIEW_INCLUDE }>;

async function toReviewItem(
  row: ReviewRow,
  photoUrl: string | null,
): Promise<VerificationReviewItem> {
  const document_url =
    row.asset && row.asset.uploaded_at
      ? await presignDownload({
          bucket: row.asset.s3_bucket as BucketName,
          key: row.asset.s3_key,
        })
      : null;

  return {
    id: row.id,
    status: row.status,
    method: row.method,
    submitted_at: row.submitted_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    user: toUserCompact(row.user, photoUrl),
    document_url,
    social_provider: row.social_provider,
  };
}

export async function listForReview(options: {
  status?: VerificationStatus;
  limit: number;
  cursor?: string;
}): Promise<{
  verifications: VerificationReviewItem[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const status = options.status ?? VerificationStatus.pending;

  const rows = await prisma.verification.findMany({
    where: {
      status,
      submitted_at: {
        not: null,
        ...(after ? { gt: new Date(String(after.k)) } : {}),
      },
    },
    include: REVIEW_INCLUDE,
    orderBy: { submitted_at: 'asc' },
    take: options.limit + 1,
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: (row.submitted_at ?? row.created_at).toISOString(),
    id: row.id,
  }));

  // One presign call for the page's profile photos, not one per row (spec §4.7).
  const photoUrls = await getPrimaryPhotoUrlsFor(page.items.map((row) => row.user_id));

  return {
    verifications: await Promise.all(
      page.items.map((row) => toReviewItem(row, photoUrls.get(row.user_id) ?? null)),
    ),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}
