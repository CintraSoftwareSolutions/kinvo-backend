import { ERROR_CODES, ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@utils/error-codes';

export type ErrorDetails = Record<string, unknown> | null;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetails;

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
