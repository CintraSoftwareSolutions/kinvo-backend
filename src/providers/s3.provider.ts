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

export const BUCKETS = {
  MEDIA: env.S3_MEDIA_BUCKET,
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
    // The local store addresses buckets by path; AWS by virtual host.
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    // Checksums only where S3 demands one. By default the SDK signs a CRC32
    // into every presigned PUT, and with no body yet it is the checksum of
    // nothing, `AAAAAA==`. AWS has accepted uploads regardless, but a store
    // that checks it refuses every one as BadDigest (DECISIONS.md, 25 Sep 2026).
    requestChecksumCalculation: 'WHEN_REQUIRED',
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

export function __resetS3Client(): void {
  client = null;
}

export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

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

export async function isStorageReachable(): Promise<boolean> {
  try {
    await headObject({ bucket: BUCKETS.MEDIA, key: '__readiness_probe__' });
    return true;
  } catch {
    return false;
  }
}
