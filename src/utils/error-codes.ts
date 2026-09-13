/**
 * Spec 4.4: the complete, stable error-code table.
 *
 * These codes are a public API contract — the Flutter app branches on them.
 * Renaming a shipped code is a breaking change. Add, never rename.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',

  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',

  FORBIDDEN: 'FORBIDDEN',
  ONBOARDING_INCOMPLETE: 'ONBOARDING_INCOMPLETE',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  PREMIUM_REQUIRED: 'PREMIUM_REQUIRED',
  USER_BLOCKED: 'USER_BLOCKED',

  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',

  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Default HTTP status for each code, per the spec 4.4 table. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  BAD_REQUEST: 400,

  AUTH_REQUIRED: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_INVALID_CREDENTIALS: 401,

  FORBIDDEN: 403,
  ONBOARDING_INCOMPLETE: 403,
  ACCOUNT_SUSPENDED: 403,
  PREMIUM_REQUIRED: 403,
  USER_BLOCKED: 403,

  NOT_FOUND: 404,
  CONFLICT: 409,

  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,

  QUOTA_EXCEEDED: 422,
  RATE_LIMITED: 429,

  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/**
 * Default user-displayable messages (spec 4.2: `message` is shown to the user).
 * Call sites may override with something more specific.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Some fields need attention.',
  BAD_REQUEST: 'We could not process that request.',

  AUTH_REQUIRED: 'Please sign in to continue.',
  AUTH_TOKEN_EXPIRED: 'Your session has expired.',
  AUTH_TOKEN_INVALID: 'Your session is no longer valid. Please sign in again.',
  AUTH_INVALID_CREDENTIALS: 'That email or password is incorrect.',

  FORBIDDEN: 'You do not have access to this.',
  ONBOARDING_INCOMPLETE: 'Finish setting up your profile to continue.',
  ACCOUNT_SUSPENDED: 'Your account has been suspended.',
  PREMIUM_REQUIRED: 'This feature is available with Premium.',
  USER_BLOCKED: 'This is not available.',

  NOT_FOUND: 'We could not find what you were looking for.',
  CONFLICT: 'That already exists.',

  FILE_TOO_LARGE: 'That file is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'That file type is not supported.',

  QUOTA_EXCEEDED: 'You have reached your limit for today.',
  RATE_LIMITED: 'Too many requests. Please try again shortly.',

  INTERNAL_ERROR: 'Something went wrong on our end.',
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable.',
};
