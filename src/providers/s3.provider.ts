import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '@config/env';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';

/**
 * Object storage (spec §2: AWS S3, presigned URLs).
 *
 * The only module that knows S3 exists. Everything else asks for an upload
 * target or a viewable URL and never sees a bucket name or a client.
 *
 * In development and tests this points at MinIO, which speaks the S3 API — so
 * the SDK, the presigning, and the bucket separation are all real, and moving
 * to AWS is a change of endpoint and credentials with no code change.
 *
 * spec §4.8: the client uploads directly to storage with a presigned URL rather
 * than streaming bytes through the API. That keeps large photo and video
 * uploads off the request path entirely.
 */

/** Two buckets, deliberately. Never merge them — see VERIFICATION below. */
export const BUCKETS = {
  /** Profile photos, chat media, voice notes. */
  MEDIA: env.S3_MEDIA_BUCKET,
  /**
   * spec §7 Batch 4: government ID images are the most sensitive data in this
   * system. A separate bucket means a separate policy, separate lifecycle
   * rules, and separate audit — none of which can be got wrong by editing the
   * photo bucket's config.
   */
  VERIFICATION: env.S3_VERIFICATION_BUCKET,
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

let client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (client) {
    return client;
  }

  client = new S3Client({
    region: env.S3_REGION,
    // Unset against real AWS, where the SDK resolves the regional endpoint.
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    // MinIO addresses buckets by path; AWS by virtual host.
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

  return client;
}

/** Test seam: forces the next call to build a fresh client. */
export function __resetS3Client(): void {
  client = null;
}

export interface PresignedUpload {
  url: string;
  /** Headers the client MUST send, or the signature will not match. */
  headers: Record<string, string>;
  expires_at: string;
}

/**
 * A URL the client can PUT bytes to, once, before it expires.
 *
 * Content type and length are part of the signature, so a client cannot
 * present a URL issued for a 2 MB JPEG and upload a 2 GB executable — S3
 * rejects the mismatch. That is the enforcement; the size check we do before
 * issuing is the friendly error.
 */
export async function presignUpload(options: {
  bucket: BucketName;
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<PresignedUpload> {
  const command = new PutObjectCommand({
    Bucket: options.bucket,
    Key: options.key,
    ContentType: options.contentType,
    ContentLength: options.contentLength,
  });

  try {
    const url = await getSignedUrl(getS3Client(), command, {
      expiresIn: env.S3_UPLOAD_URL_TTL_SECONDS,
    });

    return {
      url,
      headers: {
        'Content-Type': options.contentType,
        'Content-Length': String(options.contentLength),
      },
      expires_at: new Date(Date.now() + env.S3_UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
  } catch (error) {
    logger.error({ err: error, bucket: options.bucket }, 'failed to presign upload');
    throw new ApiError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'We could not start that upload. Please try again shortly.',
    );
  }
}

/**
 * A time-limited URL for reading an object.
 *
 * Both buckets are private, so this is the only way to view anything. The TTL
 * differs by bucket: verification documents expire far sooner than profile
 * photos, because a leaked ID-document URL is a much worse outcome than a
 * leaked selfie URL.
 */
export async function presignDownload(options: {
  bucket: BucketName;
  key: string;
  ttlSeconds?: number;
}): Promise<string> {
  const ttl =
    options.ttlSeconds ??
    (options.bucket === BUCKETS.VERIFICATION
      ? env.S3_VERIFICATION_URL_TTL_SECONDS
      : env.S3_DOWNLOAD_URL_TTL_SECONDS);

  const command = new GetObjectCommand({ Bucket: options.bucket, Key: options.key });

  try {
    return await getSignedUrl(getS3Client(), command, { expiresIn: ttl });
  } catch (error) {
    logger.error({ err: error, bucket: options.bucket }, 'failed to presign download');
    throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, 'That file is not available right now.');
  }
}

export interface ObjectFacts {
  size_bytes: number;
  content_type: string | null;
}

/**
 * Confirms an object actually landed, and reports what really arrived.
 *
 * The client tells us it finished uploading; that claim is not evidence. This
 * is how a media record only ever becomes usable once bytes genuinely exist,
 * with the size and type storage actually saw rather than the ones the client
 * promised beforehand.
 *
 * Returns null when the object is absent, which is a "you did not upload it"
 * outcome rather than an outage.
 */
export async function headObject(options: {
  bucket: BucketName;
  key: string;
}): Promise<ObjectFacts | null> {
  try {
    const result = await getS3Client().send(
      new HeadObjectCommand({ Bucket: options.bucket, Key: options.key }),
    );

    return {
      size_bytes: result.ContentLength ?? 0,
      content_type: result.ContentType ?? null,
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

    if (status === 404 || status === 403) {
      return null;
    }

    logger.error({ err: error, bucket: options.bucket }, 'failed to head object');
    throw new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Storage is not available right now.');
  }
}

/**
 * Removes an object. Never throws on a missing key — deleting something that is
 * already gone is the desired end state, not a failure.
 */
export async function deleteObject(options: { bucket: BucketName; key: string }): Promise<void> {
  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: options.bucket, Key: options.key }));
  } catch (error) {
    // Logged, not thrown: a failed storage delete must not fail the user's
    // request. The database row is already gone; an orphaned object costs
    // pennies and is swept up by lifecycle rules.
    logger.error({ err: error, bucket: options.bucket }, 'failed to delete object');
  }
}

/** Cheap probe for the readiness endpoint. */
export async function isStorageReachable(): Promise<boolean> {
  try {
    await headObject({ bucket: BUCKETS.MEDIA, key: '__readiness_probe__' });
    return true;
  } catch {
    return false;
  }
}
