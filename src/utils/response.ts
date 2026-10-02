import type { Response } from 'express';

import type { ApiError, ErrorDetails } from '@utils/api-error';
import type { ErrorCode } from '@utils/error-codes';

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
