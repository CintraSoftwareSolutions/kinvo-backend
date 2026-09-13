import type { Response } from 'express';

import type { ApiError, ErrorDetails } from '@utils/api-error';
import type { ErrorCode } from '@utils/error-codes';

/**
 * Spec 4.2 — the response envelope. Every response in this service, success or
 * failure, empty list or single object, goes through this module. The Flutter
 * app writes its networking layer once; a deviating endpoint is a bug.
 */

export interface PaginationMeta {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export interface ListMeta {
  pagination: PaginationMeta;
}

export interface SuccessEnvelope<TData> {
  success: true;
  data: TData;
  meta: ListMeta | null;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetails;
  };
}

/**
 * Spec 4.6: `data` is always an object or array, never a bare scalar.
 * Wrap scalars at the call site: `{ count: 4 }`.
 */
export type Payload = Record<string, unknown> | unknown[];

export function buildSuccess<TData extends Payload>(
  data: TData,
  meta: ListMeta | null = null,
): SuccessEnvelope<TData> {
  return { success: true, data, meta };
}

export function buildError(
  code: ErrorCode,
  message: string,
  details: ErrorDetails = null,
): ErrorEnvelope {
  return { success: false, error: { code, message, details } };
}

export function sendSuccess<TData extends Payload>(
  res: Response,
  data: TData,
  statusCode = 200,
): Response {
  return res.status(statusCode).json(buildSuccess(data));
}

/** Spec 4.5: cursor pagination for decks, matches, messages, notifications. */
export function sendList<TItem>(
  res: Response,
  data: TItem[],
  pagination: PaginationMeta,
  statusCode = 200,
): Response {
  return res.status(statusCode).json(buildSuccess(data, { pagination }));
}

export function sendError(res: Response, error: ApiError): Response {
  return res.status(error.statusCode).json(buildError(error.code, error.message, error.details));
}
