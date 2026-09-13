import { randomUUID } from 'node:crypto';

import { MediaKind, prisma } from '@/db/prisma';
import {
  BUCKETS,
  deleteObject,
  headObject,
  presignDownload,
  presignUpload,
  type BucketName,
} from '@/providers/s3.provider';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import type { MediaAssetView, UploadPolicy, UploadPurpose, UploadTicket } from './media.types';

/**
 * Uploads (spec §4.8, §7 Batch 4).
 *
 * Two steps, deliberately:
 *
 *   1. The client declares what it wants to upload. We check it against the
 *      policy, record the intent, and hand back a presigned URL.
 *   2. The client PUTs bytes straight to storage, then tells us it is done. We
 *      HEAD the object and record what ACTUALLY landed.
 *
 * Step 2 is not a formality. Everything the client says in step 1 is a claim;
 * only the HEAD is evidence. An asset with no `uploaded_at` may never be
 * attached to anything.
 */

const MB = 1024 * 1024;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * The policy table. Every limit lives here rather than scattered through
 * handlers, so "what may a user upload" is answerable by reading one object.
 */
export const UPLOAD_POLICIES: Record<UploadPurpose, UploadPolicy> = {
  profile_photo: {
    bucket: BUCKETS.MEDIA,
    mime_types: IMAGE_TYPES,
    max_bytes: 10 * MB,
    requires_duration: false,
  },
  chat_image: {
    bucket: BUCKETS.MEDIA,
    mime_types: IMAGE_TYPES,
    max_bytes: 10 * MB,
    requires_duration: false,
  },
  chat_video: {
    bucket: BUCKETS.MEDIA,
    mime_types: ['video/mp4', 'video/quicktime'],
    max_bytes: 100 * MB,
    requires_duration: false,
  },
  voice_note: {
    bucket: BUCKETS.MEDIA,
    mime_types: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm'],
    max_bytes: 10 * MB,
    // spec §5.4: voice notes carry duration.
    requires_duration: true,
    max_duration_ms: 120_000,
  },
  verification_document: {
    // Separate bucket, stricter lifecycle, shorter URL lifetime.
    bucket: BUCKETS.VERIFICATION,
    mime_types: [...IMAGE_TYPES, 'application/pdf'],
    max_bytes: 20 * MB,
    requires_duration: false,
  },
  report_evidence: {
    bucket: BUCKETS.VERIFICATION,
    mime_types: [...IMAGE_TYPES, 'video/mp4'],
    max_bytes: 20 * MB,
    requires_duration: false,
  },
};

const PURPOSE_TO_KIND: Record<UploadPurpose, MediaKind> = {
  profile_photo: MediaKind.profile_photo,
  chat_image: MediaKind.chat_image,
  chat_video: MediaKind.chat_video,
  voice_note: MediaKind.voice_note,
  verification_document: MediaKind.verification_document,
  report_evidence: MediaKind.report_evidence,
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
};

/**
 * Object keys are namespaced by purpose and owner, and end in a random UUID.
 *
 * The randomness matters: a guessable key plus any future misconfiguration of
 * the bucket policy would turn into enumerable private media. The owner prefix
 * is what makes lifecycle rules and bulk erasure expressible.
 */
function buildKey(userId: string, purpose: UploadPurpose, mimeType: string): string {
  const extension = EXTENSIONS[mimeType] ?? 'bin';
  return `${purpose}/${userId}/${randomUUID()}.${extension}`;
}

export interface CreateUploadInput {
  purpose: UploadPurpose;
  mime_type: string;
  size_bytes: number;
  duration_ms?: number;
}

export async function createUpload(
  userId: string,
  input: CreateUploadInput,
): Promise<UploadTicket> {
  const policy = UPLOAD_POLICIES[input.purpose];

  if (!policy) {
    throw ApiError.validation({ purpose: ['That upload type is not supported.'] });
  }

  // spec §4.4: 415 for a bad type, 413 for a too-large file — distinct codes so
  // the app can say something useful rather than "upload failed".
  if (!policy.mime_types.includes(input.mime_type)) {
    throw new ApiError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 'That file type is not supported.', {
      allowed_mime_types: [...policy.mime_types],
    });
  }

  if (input.size_bytes > policy.max_bytes) {
    throw new ApiError(
      ERROR_CODES.FILE_TOO_LARGE,
      `That file is too large. The limit is ${Math.floor(policy.max_bytes / MB)}MB.`,
      { max_bytes: policy.max_bytes, size_bytes: input.size_bytes },
    );
  }

  if (policy.requires_duration && !input.duration_ms) {
    throw ApiError.validation({ duration_ms: ['A duration is required for this upload.'] });
  }

  if (policy.max_duration_ms && input.duration_ms && input.duration_ms > policy.max_duration_ms) {
    throw ApiError.validation({
      duration_ms: [`That is too long. The limit is ${policy.max_duration_ms / 1000} seconds.`],
    });
  }

  const key = buildKey(userId, input.purpose, input.mime_type);

  const asset = await prisma.mediaAsset.create({
    data: {
      owner_id: userId,
      kind: PURPOSE_TO_KIND[input.purpose],
      s3_bucket: policy.bucket,
      s3_key: key,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      duration_ms: input.duration_ms ?? null,
      // uploaded_at stays null: this is an intent, not an asset, until the
      // bytes are confirmed.
    },
    select: { id: true },
  });

  const upload = await presignUpload({
    bucket: policy.bucket,
    key,
    contentType: input.mime_type,
    contentLength: input.size_bytes,
  });

  return {
    upload_id: asset.id,
    purpose: input.purpose,
    url: upload.url,
    headers: upload.headers,
    expires_at: upload.expires_at,
  };
}

interface AssetRow {
  id: string;
  kind: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  moderation_status: string;
  uploaded_at: Date | null;
  created_at: Date;
}

function toAssetView(asset: AssetRow): MediaAssetView {
  return {
    id: asset.id,
    kind: asset.kind,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    duration_ms: asset.duration_ms,
    moderation_status: asset.moderation_status,
    is_uploaded: asset.uploaded_at !== null,
    // Filled in by whichever caller knows the viewer may see it.
    url: null,
    created_at: asset.created_at.toISOString(),
  };
}

/**
 * Confirms an upload by asking storage what is actually there.
 *
 * Idempotent — completing twice returns the same asset rather than erroring,
 * because a retried request on a mobile connection is normal.
 */
export async function completeUpload(userId: string, uploadId: string): Promise<MediaAssetView> {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: uploadId, owner_id: userId, deleted_at: null },
  });

  // Scoped to the owner, so probing someone else's upload id is a 404 rather
  // than a confirmation that it exists.
  if (!asset) {
    throw ApiError.notFound('That upload does not exist.');
  }

  if (asset.uploaded_at) {
    return toAssetView(asset);
  }

  const facts = await headObject({ bucket: asset.s3_bucket as BucketName, key: asset.s3_key });

  if (!facts) {
    throw new ApiError(
      ERROR_CODES.BAD_REQUEST,
      'We could not find that file. Upload it before completing.',
    );
  }

  // Record what storage saw, not what the client promised. A client that
  // declared 1MB and uploaded 9MB is recorded at 9MB.
  const updated = await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: {
      uploaded_at: new Date(),
      size_bytes: facts.size_bytes,
      ...(facts.content_type ? { mime_type: facts.content_type } : {}),
    },
  });

  logger.info({ user_id: userId, asset_id: asset.id, kind: asset.kind }, 'upload completed');

  return toAssetView(updated);
}

/**
 * A viewable URL for an asset the caller owns.
 *
 * spec §4.8: media pending moderation is visible to its owner and nobody else.
 * This only ever serves the owner; anything serving media to another user must
 * check moderation status itself.
 */
export async function getOwnAssetUrl(userId: string, assetId: string): Promise<string> {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: assetId, owner_id: userId, deleted_at: null, uploaded_at: { not: null } },
    select: { s3_bucket: true, s3_key: true },
  });

  if (!asset) {
    throw ApiError.notFound();
  }

  return presignDownload({ bucket: asset.s3_bucket as BucketName, key: asset.s3_key });
}

export interface ClaimedAsset {
  id: string;
  s3_bucket: string;
  s3_key: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
}

/**
 * Claims a completed asset for a specific purpose.
 *
 * Used by anything that attaches media — a photo, a verification document, a
 * chat message. Enforces ownership, completion, and the expected kind, so a
 * verification document can never be passed off as a profile photo.
 */
export async function claimAsset(options: {
  userId: string;
  assetId: string;
  expectedKind: MediaKind;
}): Promise<ClaimedAsset> {
  const asset = await prisma.mediaAsset.findFirst({
    where: {
      id: options.assetId,
      owner_id: options.userId,
      kind: options.expectedKind,
      deleted_at: null,
    },
    select: {
      id: true,
      s3_bucket: true,
      s3_key: true,
      mime_type: true,
      size_bytes: true,
      duration_ms: true,
      uploaded_at: true,
    },
  });

  if (!asset) {
    throw ApiError.notFound('That upload does not exist.');
  }

  if (!asset.uploaded_at) {
    throw new ApiError(
      ERROR_CODES.BAD_REQUEST,
      'That upload has not finished. Complete it before using it.',
    );
  }

  return asset;
}

/** Soft-deletes the record and removes the bytes. */
export async function deleteAsset(userId: string, assetId: string): Promise<void> {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: assetId, owner_id: userId, deleted_at: null },
    select: { id: true, s3_bucket: true, s3_key: true },
  });

  if (!asset) {
    throw ApiError.notFound();
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { deleted_at: new Date() },
  });

  await deleteObject({ bucket: asset.s3_bucket as BucketName, key: asset.s3_key });
}
