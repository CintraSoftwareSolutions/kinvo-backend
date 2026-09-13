import { API_PREFIX } from '@config/constants';
import type { AuthTokens } from '@modules/auth/auth.types';
import { api } from './request';
import { authHeader } from './auth';

/**
 * Upload helpers.
 *
 * These perform genuine round trips: the API issues a presigned URL, the test
 * PUTs bytes straight to MinIO exactly as the app would, and the API confirms
 * by asking storage what landed. Nothing about the storage path is faked.
 */

export const MEDIA_BASE = `${API_PREFIX}/media`;
export const VERIFICATION_BASE = `${API_PREFIX}/verification`;

/** The smallest valid PNG: an 8-bit 1x1 image. Real bytes, real content type. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface UploadedAsset {
  upload_id: string;
  url: string;
}

/**
 * Runs the whole handshake: request a URL, PUT the bytes, confirm.
 * Returns the completed asset id, ready to attach.
 */
export async function uploadFile(
  tokens: AuthTokens,
  options: {
    purpose?: string;
    body?: Buffer;
    mimeType?: string;
    durationMs?: number;
  } = {},
): Promise<UploadedAsset> {
  const body = options.body ?? TINY_PNG;
  const mimeType = options.mimeType ?? 'image/png';

  const ticket = await api
    .post(`${MEDIA_BASE}/uploads`)
    .set(authHeader(tokens))
    .send({
      purpose: options.purpose ?? 'profile_photo',
      mime_type: mimeType,
      size_bytes: body.byteLength,
      ...(options.durationMs ? { duration_ms: options.durationMs } : {}),
    });

  if (ticket.status !== 201) {
    throw new Error(`upload ticket failed: ${ticket.status} ${JSON.stringify(ticket.body)}`);
  }

  const put = await fetch(ticket.body.data.url as string, {
    method: 'PUT',
    headers: ticket.body.data.headers as Record<string, string>,
    body: new Uint8Array(body),
  });

  if (!put.ok) {
    throw new Error(`direct PUT to storage failed: ${put.status}`);
  }

  const uploadId = ticket.body.data.upload_id as string;

  const complete = await api
    .post(`${MEDIA_BASE}/uploads/${uploadId}/complete`)
    .set(authHeader(tokens));

  if (complete.status !== 200) {
    throw new Error(`complete failed: ${complete.status} ${JSON.stringify(complete.body)}`);
  }

  return { upload_id: uploadId, url: ticket.body.data.url as string };
}

/** Uploads and attaches a profile photo, returning the created photo. */
export async function addPhoto(tokens: AuthTokens): Promise<Record<string, unknown>> {
  const asset = await uploadFile(tokens, { purpose: 'profile_photo' });

  const response = await api
    .post(`${MEDIA_BASE}/photos`)
    .set(authHeader(tokens))
    .send({ upload_id: asset.upload_id });

  if (response.status !== 201) {
    throw new Error(`add photo failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return response.body.data as Record<string, unknown>;
}
