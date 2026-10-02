import { MediaKind, ModerationStatus, prisma } from '@/db/prisma';

import { deleteObject, presignDownload, type BucketName } from '@/providers/s3.provider';
import { scanSubject } from '@modules/moderation/moderation.service';
import { ensureProfile } from '@modules/profiles/profile.repository';
import { refreshCompletion } from '@modules/profiles/completion.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { claimAsset } from './media.service';
import type { PhotoView } from './media.types';

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

  if (remaining.length === 0 && (await isOnboarded(userId))) {
    throw new ApiError(
      ERROR_CODES.CONFLICT,
      'Your profile needs at least one photo. Add another one, then remove this one.',
      { min_photos: 1 },
    );
  }

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

export async function setPrimaryPhoto(userId: string, photoId: string): Promise<PhotoView[]> {
  const profileId = await ensureProfile(userId);
  const photos = await livePhotos(profileId);

  if (!photos.some((photo) => photo.id === photoId)) {
    throw ApiError.notFound('That photo does not exist.');
  }

  return reorderPhotos(userId, [
    photoId,
    ...photos.filter((photo) => photo.id !== photoId).map((photo) => photo.id),
  ]);
}

async function isOnboarded(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboarded_at: true },
  });

  return Boolean(user?.onboarded_at);
}

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

export interface PublicPhotoView {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

async function toPublicPhotoView(photo: {
  id: string;
  s3_bucket: string;
  s3_key: string;
  width: number | null;
  height: number | null;
}): Promise<PublicPhotoView> {
  return {
    id: photo.id,
    url: await presignDownload({ bucket: photo.s3_bucket as BucketName, key: photo.s3_key }),
    width: photo.width,
    height: photo.height,
  };
}

export async function getApprovedPhotosFor(userId: string): Promise<PublicPhotoView[]> {
  const photos = await prisma.photo.findMany({
    where: {
      profile: { user_id: userId },
      deleted_at: null,
      moderation_status: ModerationStatus.approved,
    },
    orderBy: { position: 'asc' },
    select: { id: true, s3_bucket: true, s3_key: true, width: true, height: true },
  });

  return Promise.all(photos.map(toPublicPhotoView));
}

export async function getApprovedPhotosForMany(
  userIds: string[],
): Promise<Map<string, PublicPhotoView[]>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const photos = await prisma.photo.findMany({
    where: {
      profile: { user_id: { in: userIds } },
      deleted_at: null,
      moderation_status: ModerationStatus.approved,
    },
    orderBy: { position: 'asc' },
    select: {
      id: true,
      s3_bucket: true,
      s3_key: true,
      width: true,
      height: true,
      profile: { select: { user_id: true } },
    },
  });

  const byUser = new Map<string, PublicPhotoView[]>();
  for (const photo of photos) {
    const views = byUser.get(photo.profile.user_id) ?? [];
    views.push(await toPublicPhotoView(photo));
    byUser.set(photo.profile.user_id, views);
  }

  return byUser;
}

export async function countApprovedPhotos(userId: string): Promise<number> {
  return prisma.photo.count({
    where: {
      profile: { user_id: userId },
      deleted_at: null,
      moderation_status: ModerationStatus.approved,
    },
  });
}

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
