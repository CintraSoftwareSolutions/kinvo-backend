import { MediaKind, ModerationStatus, prisma } from '@/db/prisma';

import { deleteObject, presignDownload, type BucketName } from '@/providers/s3.provider';
import { scanSubject } from '@modules/moderation/moderation.service';
import { ensureProfile } from '@modules/profiles/profile.repository';
import { refreshCompletion } from '@modules/profiles/completion.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { claimAsset } from './media.service';
import type { PhotoView } from './media.types';

/**
 * Profile photos (spec §7, Batch 4: photo CRUD, reorder, set primary, max 6).
 *
 * Photos are their own table rather than rows in MediaAsset because they are
 * read on every deck card and every list; a join through a generic asset table
 * would be a self-inflicted N+1 (spec §4.7). The MediaAsset row remains as the
 * upload ledger, and the bucket and key are copied here on attach.
 */

export const MAX_PHOTOS = 6;

interface PhotoRow {
  id: string;
  s3_bucket: string;
  s3_key: string;
  position: number;
  is_primary: boolean;
  moderation_status: string;
  width: number | null;
  height: number | null;
  created_at: Date;
}

async function toPhotoView(photo: PhotoRow): Promise<PhotoView> {
  return {
    id: photo.id,
    // Both buckets are private, so every URL is time-limited and minted on read.
    url: await presignDownload({ bucket: photo.s3_bucket as BucketName, key: photo.s3_key }),
    position: photo.position,
    is_primary: photo.is_primary,
    moderation_status: photo.moderation_status,
    width: photo.width,
    height: photo.height,
    created_at: photo.created_at.toISOString(),
  };
}

async function livePhotos(profileId: string): Promise<PhotoRow[]> {
  return prisma.photo.findMany({
    where: { profile_id: profileId, deleted_at: null },
    orderBy: { position: 'asc' },
  });
}

export async function listPhotos(userId: string): Promise<PhotoView[]> {
  const profileId = await ensureProfile(userId);
  const photos = await livePhotos(profileId);

  return Promise.all(photos.map(toPhotoView));
}

export interface AddPhotoInput {
  upload_id: string;
  width?: number;
  height?: number;
}

/**
 * Attaches a completed upload as a profile photo.
 *
 * The first photo becomes primary automatically — a profile with photos but no
 * primary would render a blank deck card.
 */
export async function addPhoto(userId: string, input: AddPhotoInput): Promise<PhotoView> {
  const profileId = await ensureProfile(userId);

  // Ownership, completion, and kind are all enforced here. An asset uploaded as
  // a verification document cannot be attached as a profile photo.
  const asset = await claimAsset({
    userId,
    assetId: input.upload_id,
    expectedKind: MediaKind.profile_photo,
  });

  const existing = await livePhotos(profileId);

  if (existing.length >= MAX_PHOTOS) {
    throw new ApiError(
      ERROR_CODES.CONFLICT,
      `You can have at most ${MAX_PHOTOS} photos. Remove one first.`,
      { max_photos: MAX_PHOTOS, current: existing.length },
    );
  }

  const alreadyAttached = await prisma.photo.findFirst({
    where: { profile_id: profileId, s3_key: asset.s3_key, deleted_at: null },
    select: { id: true },
  });

  if (alreadyAttached) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That photo has already been added.');
  }

  // First live photo takes the primary slot and position 0.
  const isFirst = existing.length === 0;
  const position = existing.length;

  const photo = await prisma.photo.create({
    data: {
      profile_id: profileId,
      s3_bucket: asset.s3_bucket,
      s3_key: asset.s3_key,
      // The stored URL column is unused: both buckets are private, so a URL is
      // minted per read and would be stale the moment it was written.
      url: '',
      position,
      is_primary: isFirst,
      size_bytes: asset.size_bytes,
      width: input.width ?? null,
      height: input.height ?? null,
      // Photos go live and are reviewed AFTER the fact (spec §7, Batch 10:
      // "post-hoc scanning queue"). The alternative — every photo pending until
      // a human looks — means nobody can finish onboarding until a moderator is
      // awake, which is not a product.
      //
      // The safety net is the flag raised below: rules-based v1 cannot read
      // pixels, so every photo is queued for a person rather than quietly
      // marked clean. A moderator rejecting one hides it immediately.
      moderation_status: ModerationStatus.approved,
    },
  });

  // Queued for human review. Deliberately after the photo exists and outside
  // any transaction: a moderation queue failing must never cost a user their
  // upload.
  await scanSubject({
    userId,
    subjectType: 'photo',
    subjectId: photo.id,
    content: null,
  });

  // Photos are a scored criterion, so the stored percentage would otherwise go
  // stale the moment one is added.
  await refreshCompletion(userId);

  return toPhotoView(photo);
}

/**
 * Removes a photo and closes the gap in the ordering.
 *
 * Soft delete keeps the row for moderation history. The partial unique indexes
 * from Batch 1 exclude soft-deleted rows, so the freed position and primary
 * slot become available again immediately.
 */
export async function deletePhoto(userId: string, photoId: string): Promise<void> {
  const profileId = await ensureProfile(userId);

  const photo = await prisma.photo.findFirst({
    where: { id: photoId, profile_id: profileId, deleted_at: null },
  });

  // Scoped to the caller's own profile: another user's photo id is a 404, not
  // a 403 that would confirm it exists.
  if (!photo) {
    throw ApiError.notFound('That photo does not exist.');
  }

  const remaining = (await livePhotos(profileId)).filter((row) => row.id !== photoId);

  await prisma.$transaction([
    // The position is left alone: once `deleted_at` is set the row falls out of
    // the partial unique index, so it no longer occupies a slot and does not
    // need moving out of the way.
    prisma.photo.update({
      where: { id: photoId },
      data: { deleted_at: new Date(), is_primary: false },
    }),
    // Re-pack positions so they stay 0..n-1 with no holes.
    ...remaining.map((row, index) =>
      prisma.photo.update({
        where: { id: row.id },
        data: {
          position: index,
          is_primary: index === 0 && photo.is_primary ? true : row.is_primary,
        },
      }),
    ),
  ]);

  await refreshCompletion(userId);

  await deleteObject({ bucket: photo.s3_bucket as BucketName, key: photo.s3_key });
}

/**
 * Reorders photos to exactly the given sequence.
 *
 * Positions are moved to a temporary negative range first. The partial unique
 * index on (profile_id, position) would otherwise reject any swap that passes
 * through a duplicate position mid-update, which every reorder does.
 */
export async function reorderPhotos(userId: string, photoIds: string[]): Promise<PhotoView[]> {
  const profileId = await ensureProfile(userId);
  const photos = await livePhotos(profileId);

  const liveIds = new Set(photos.map((photo) => photo.id));
  const requested = new Set(photoIds);

  if (photoIds.length !== photos.length || requested.size !== photoIds.length) {
    throw ApiError.validation({
      photo_ids: ['List every photo exactly once, in the order you want.'],
    });
  }

  for (const id of photoIds) {
    if (!liveIds.has(id)) {
      throw ApiError.validation({ photo_ids: ['That list contains a photo we do not recognise.'] });
    }
  }

  await prisma.$transaction([
    // Phase one parks every photo out of the way AND clears every primary flag.
    // Clearing matters as much as the position: promoting the new first photo
    // while the old one is still primary trips the partial unique index that
    // allows only one primary per profile.
    ...photos.map((photo, index) =>
      prisma.photo.update({
        where: { id: photo.id },
        data: { position: -(index + 1), is_primary: false },
      }),
    ),
    // Phase two lands them in the requested order.
    ...photoIds.map((id, index) =>
      prisma.photo.update({
        where: { id },
        data: { position: index, is_primary: index === 0 },
      }),
    ),
  ]);

  return Promise.all((await livePhotos(profileId)).map(toPhotoView));
}

/** Promotes one photo to primary. Exactly one primary exists at all times. */
export async function setPrimaryPhoto(userId: string, photoId: string): Promise<PhotoView[]> {
  const profileId = await ensureProfile(userId);

  const target = await prisma.photo.findFirst({
    where: { id: photoId, profile_id: profileId, deleted_at: null },
    select: { id: true },
  });

  if (!target) {
    throw ApiError.notFound('That photo does not exist.');
  }

  // Clearing before setting: the partial unique index allows only one primary
  // per profile, so both must not be true even momentarily.
  await prisma.$transaction([
    prisma.photo.updateMany({
      where: { profile_id: profileId, deleted_at: null },
      data: { is_primary: false },
    }),
    prisma.photo.update({ where: { id: photoId }, data: { is_primary: true } }),
  ]);

  return Promise.all((await livePhotos(profileId)).map(toPhotoView));
}

/**
 * The primary photo URL for a user, as shown to someone else.
 *
 * Returns null unless a photo exists AND moderation has approved it — spec §4.8
 * says pending media is visible to its owner and nobody else, and a deck card
 * is the clearest place that rule could be broken.
 */
export async function getPrimaryPhotoUrlFor(userId: string): Promise<string | null> {
  const photo = await prisma.photo.findFirst({
    where: {
      profile: { user_id: userId },
      deleted_at: null,
      is_primary: true,
      moderation_status: ModerationStatus.approved,
    },
    select: { s3_bucket: true, s3_key: true },
  });

  if (!photo) {
    return null;
  }

  return presignDownload({ bucket: photo.s3_bucket as BucketName, key: photo.s3_key });
}

/** Batch 5 will require at least one approved photo before onboarding completes. */
export async function countApprovedPhotos(userId: string): Promise<number> {
  return prisma.photo.count({
    where: {
      profile: { user_id: userId },
      deleted_at: null,
      moderation_status: ModerationStatus.approved,
    },
  });
}

/**
 * Primary photo URLs for many users at once.
 *
 * A deck of 20 cards calling {@link getPrimaryPhotoUrlFor} per card is 20 round
 * trips and 20 presign operations — the N+1 that spec §4.7 exists to prevent.
 * Every list endpoint that returns user_compact must use this.
 *
 * Users with no approved primary photo are absent from the map, and callers
 * pass `?? null` so the key is still present in the response (spec §4.6).
 */
export async function getPrimaryPhotoUrlsFor(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const photos = await prisma.photo.findMany({
    where: {
      profile: { user_id: { in: userIds } },
      deleted_at: null,
      is_primary: true,
      moderation_status: ModerationStatus.approved,
    },
    select: { s3_bucket: true, s3_key: true, profile: { select: { user_id: true } } },
  });

  const entries = await Promise.all(
    photos.map(
      async (photo) =>
        [
          photo.profile.user_id,
          await presignDownload({ bucket: photo.s3_bucket as BucketName, key: photo.s3_key }),
        ] as const,
    ),
  );

  return new Map(entries);
}
