import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { sendError } from '@utils/response';

/** Express body-parser errors carry these extra fields. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
  body?: unknown;
}

/** Spec 4.2: validation `details` is keyed by field, each value a message list. */
export function zodErrorToDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    const bucket = details[key];
    if (bucket) {
      bucket.push(issue.message);
    } else {
      details[key] = [issue.message];
    }
  }

  return details;
}

function normalise(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof ZodError) {
    return ApiError.validation(zodErrorToDetails(error));
  }

  const candidate = error as BodyParserError | undefined;

  // express.json() rejects oversized bodies before the route ever runs.
  if (candidate?.type === 'entity.too.large') {
    return new ApiError(ERROR_CODES.FILE_TOO_LARGE, 'That request body is too large.');
  }

  // Malformed JSON — not field-specific, so BAD_REQUEST rather than VALIDATION_FAILED.
  // `body` is checked first: narrowing to SyntaxError would discard the
  // body-parser fields that distinguish this from an ordinary syntax error.
  if (candidate?.body !== undefined && candidate instanceof SyntaxError) {
    return ApiError.badRequest('The request body is not valid JSON.');
  }

  if (candidate?.type === 'charset.unsupported' || candidate?.type === 'encoding.unsupported') {
    return new ApiError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
  }

  return ApiError.internal();
}

/**
 * Terminal error handler. Must keep all four parameters — Express identifies
 * error middleware by arity.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Response already streaming; hand back to Express to destroy the socket.
  if (res.headersSent) {
    next(err);
    return;
  }

  const apiError = normalise(err);
  const log = req.log ?? logger;

  if (apiError.statusCode >= 500) {
    // Unexpected: keep the stack in the logs and out of the response body.
    log.error({ err, code: apiError.code }, 'unhandled error');
  } else {
    log.debug({ code: apiError.code, status: apiError.statusCode }, 'request error');
  }

  sendError(res, apiError);
};
