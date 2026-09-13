import { ERROR_CODES, ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@utils/error-codes';

/**
 * Field-keyed validation details (spec 4.2) or free-form paywall/quota context
 * (spec 4.4). Always serialisable — it goes straight into the response body.
 */
export type ErrorDetails = Record<string, unknown> | null;

/**
 * The only error type route/service code should throw when it wants to control
 * the response. Anything else reaching the error handler becomes INTERNAL_ERROR.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetails;

  /** Distinguishes expected failures from genuine bugs when logging. */
  readonly isOperational = true;

  constructor(
    code: ErrorCode,
    message?: string,
    details: ErrorDetails = null,
    statusCode?: number,
  ) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode ?? ERROR_STATUS[code];
    this.details = details;
    Error.captureStackTrace(this, ApiError);
  }

  /** Spec 4.2: `details` keyed by field name, each value a list of messages. */
  static validation(details: Record<string, string[]>, message?: string): ApiError {
    return new ApiError(ERROR_CODES.VALIDATION_FAILED, message, details);
  }

  static badRequest(message?: string, details: ErrorDetails = null): ApiError {
    return new ApiError(ERROR_CODES.BAD_REQUEST, message, details);
  }

  static notFound(message?: string): ApiError {
    return new ApiError(ERROR_CODES.NOT_FOUND, message);
  }

  static internal(message?: string): ApiError {
    return new ApiError(ERROR_CODES.INTERNAL_ERROR, message);
  }
}
