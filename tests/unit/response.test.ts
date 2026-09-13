import { ApiError } from '@utils/api-error';
import { ERROR_CODES, ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@utils/error-codes';
import { buildError, buildSuccess } from '@utils/response';

describe('response envelope (spec 4.2)', () => {
  it('wraps object data with a null meta', () => {
    expect(buildSuccess({ id: 'abc' })).toEqual({
      success: true,
      data: { id: 'abc' },
      meta: null,
    });
  });

  it('returns an empty array, never null, for empty lists (spec 4.6)', () => {
    const envelope = buildSuccess([]);

    expect(envelope.data).toEqual([]);
    expect(envelope.data).not.toBeNull();
  });

  it('attaches cursor pagination meta for lists (spec 4.5)', () => {
    const envelope = buildSuccess([{ id: 'a' }], {
      pagination: { next_cursor: 'eyJpZCI6MTIzfQ', has_more: true, limit: 20 },
    });

    expect(envelope.meta).toEqual({
      pagination: { next_cursor: 'eyJpZCI6MTIzfQ', has_more: true, limit: 20 },
    });
  });

  it('keeps next_cursor as null rather than omitting the key', () => {
    const envelope = buildSuccess([], {
      pagination: { next_cursor: null, has_more: false, limit: 20 },
    });

    expect(envelope.meta?.pagination).toHaveProperty('next_cursor', null);
  });

  it('builds an error envelope with details present even when null', () => {
    const envelope = buildError(ERROR_CODES.AUTH_TOKEN_EXPIRED, 'Your session has expired.');

    expect(envelope).toEqual({
      success: false,
      error: {
        code: 'AUTH_TOKEN_EXPIRED',
        message: 'Your session has expired.',
        details: null,
      },
    });
    expect(Object.keys(envelope.error)).toContain('details');
  });

  it('keys validation details by field name', () => {
    const envelope = buildError(ERROR_CODES.VALIDATION_FAILED, 'Some fields need attention.', {
      email: ['Enter a valid email address.'],
    });

    expect(envelope.error.details).toEqual({ email: ['Enter a valid email address.'] });
  });
});

describe('ApiError', () => {
  it('derives the HTTP status from the code', () => {
    expect(new ApiError(ERROR_CODES.NOT_FOUND).statusCode).toBe(404);
    expect(new ApiError(ERROR_CODES.QUOTA_EXCEEDED).statusCode).toBe(422);
    expect(new ApiError(ERROR_CODES.RATE_LIMITED).statusCode).toBe(429);
  });

  it('falls back to the default user-displayable message', () => {
    expect(new ApiError(ERROR_CODES.PREMIUM_REQUIRED).message).toBe(
      ERROR_MESSAGES.PREMIUM_REQUIRED,
    );
  });

  it('separates the three auth codes the client branches on (spec 4.3)', () => {
    const codes: ErrorCode[] = ['AUTH_REQUIRED', 'AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID'];
    const messages = codes.map((code) => new ApiError(code).message);

    expect(new Set(codes).size).toBe(3);
    expect(new Set(messages).size).toBe(3);
    codes.forEach((code) => expect(ERROR_STATUS[code]).toBe(401));
  });

  it('exposes a validation factory keyed by field', () => {
    const error = ApiError.validation({ password: ['Too short.'] });

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ password: ['Too short.'] });
  });

  it('marks errors as operational and keeps the stack off the payload', () => {
    const error = ApiError.notFound();

    expect(error.isOperational).toBe(true);
    expect(error.stack).toEqual(expect.any(String));
    expect(error.details).toBeNull();
  });

  it('defines a status and a message for every code in the table', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_STATUS[code]).toEqual(expect.any(Number));
      expect(ERROR_MESSAGES[code]).toEqual(expect.any(String));
    }
  });
});
