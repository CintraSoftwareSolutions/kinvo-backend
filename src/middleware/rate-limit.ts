import type { Request, RequestHandler, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

import { env, isTest } from '@config/env';
import { redis } from '@/db/redis';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

let disabledForTests = isTest;

export function setRateLimitingDisabled(disabled: boolean): void {
  if (!isTest) {
    throw new Error('Rate limiting may only be toggled in tests');
  }
  disabledForTests = disabled;
}

type KeySelector = (req: Request) => string;

interface LimitDefinition {
  name: string;
  windowMs: number;
  limit: number;
  key?: KeySelector;
  message?: string;
}

function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

function bodyField(field: string): KeySelector {
  return (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    const value = body?.[field];
    const identifier = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return identifier.length > 0 ? `${field}:${identifier}` : `ip:${clientIp(req)}`;
  };
}

function build(definition: LimitDefinition): RequestHandler {
  const options: Partial<Options> = {
    windowMs: definition.windowMs,
    limit: definition.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: true,

    keyGenerator: (req: Request) =>
      `${definition.name}:${definition.key ? definition.key(req) : `ip:${clientIp(req)}`}`,

    handler: (_req: Request, res: Response) => {
      const retryAfter = res.getHeader('Retry-After');

      throw new ApiError(
        ERROR_CODES.RATE_LIMITED,
        definition.message ?? 'Too many requests. Please try again shortly.',
        {
          retry_after_seconds:
            typeof retryAfter === 'string' ? Number.parseInt(retryAfter, 10) : (retryAfter ?? null),
        },
      );
    },

    skipSuccessfulRequests: false,

    skip: () => disabledForTests,
  };

  if (!isTest) {
    options.store = new RedisStore({
      sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
      prefix: 'rl:',
    });
  }

  return rateLimit(options);
}

export const loginRateLimit = build({
  name: 'login',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  key: bodyField('email'),
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

export const registerRateLimit = build({
  name: 'register',
  windowMs: 60 * 60 * 1000,
  limit: 10,
});

export const otpSendRateLimit = build({
  name: 'otp-send',
  windowMs: 60 * 60 * 1000,
  limit: 5,
  key: bodyField('phone'),
  message: 'Too many codes requested. Please wait before asking for another.',
});

export const otpVerifyRateLimit = build({
  name: 'otp-verify',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  key: bodyField('phone'),
});

export const passwordResetRateLimit = build({
  name: 'password-reset',
  windowMs: 60 * 60 * 1000,
  limit: 5,
  key: bodyField('email'),
  message: 'Too many reset requests. Please check your inbox and try again later.',
});

export const passwordResetConfirmRateLimit = build({
  name: 'password-reset-confirm',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  key: bodyField('email'),
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

export const socialSignInRateLimit = build({
  name: 'social-signin',
  windowMs: 15 * 60 * 1000,
  limit: 20,
});

export const refreshRateLimit = build({
  name: 'refresh',
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export const generalRateLimit = build({
  name: 'general',
  windowMs: 15 * 60 * 1000,
  limit: env.RATE_LIMIT_GENERAL_MAX,
});

export const callStartRateLimit = build({
  name: 'call-start',
  windowMs: 5 * 60 * 1000,
  limit: 10,
  key: (req) => `user:${req.user?.id ?? `ip:${clientIp(req)}`}`,
  message: 'You are starting calls too quickly. Please wait a moment.',
});
