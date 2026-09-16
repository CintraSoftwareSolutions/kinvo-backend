import type { Request, RequestHandler, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

import { env, isTest } from '@config/env';
import { redis } from '@/db/redis';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * Rate limits protect infrastructure (spec §4.9).
 *
 * They are NOT business quotas. A limit here returns 429 RATE_LIMITED with a
 * Retry-After header. A business limit that exists to sell subscriptions —
 * daily swipes, daily messages — returns 422 QUOTA_EXCEEDED with paywall
 * context and lives in the entitlements module (Batch 6). Conflating the two
 * hides the paywall and costs revenue, so they share no code deliberately.
 *
 * Counters live in Redis so a limit means the same thing across every instance.
 */

/**
 * Test suites make far more requests from one address than any real client, so
 * limits are off by default under test and switched on by the suite that
 * actually asserts them. Never disabled outside tests.
 */
let disabledForTests = isTest;

export function setRateLimitingDisabled(disabled: boolean): void {
  if (!isTest) {
    throw new Error('Rate limiting may only be toggled in tests');
  }
  disabledForTests = disabled;
}

/** Counts per identifier rather than per IP where the abuse target is an account. */
type KeySelector = (req: Request) => string;

interface LimitDefinition {
  name: string;
  windowMs: number;
  limit: number;
  key?: KeySelector;
  message?: string;
}

/**
 * Behind a load balancer `req.ip` is only trustworthy because app.ts sets
 * `trust proxy`. Falls back to a constant rather than `undefined`, which would
 * give every unidentifiable caller its own bucket.
 */
function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

/** Lower-cased so casing variations do not each get a fresh allowance. */
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

    // Spec §4.9 names X-RateLimit-* explicitly, so the legacy headers are the
    // client contract and must stay on — the Flutter app reads them. The
    // draft-7 `RateLimit` header is emitted alongside for standards-compliant
    // tooling. Retry-After is added automatically when a request is limited.
    standardHeaders: 'draft-7',
    legacyHeaders: true,

    keyGenerator: (req: Request) =>
      `${definition.name}:${definition.key ? definition.key(req) : `ip:${clientIp(req)}`}`,

    // Every response, limited or not, must use the spec §4.2 envelope.
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

    // Successful requests still count: the point is to bound total load.
    skipSuccessfulRequests: false,

    skip: () => disabledForTests,
  };

  // In tests the store would need a live Redis for suites that never touch it.
  // The default in-memory store keeps the middleware's behaviour identical.
  if (!isTest) {
    options.store = new RedisStore({
      sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
      prefix: 'rl:',
    });
  }

  return rateLimit(options);
}

/**
 * Sign-in attempts, keyed on the email being attacked rather than the caller's
 * IP — credential stuffing rotates IPs but must target a fixed account.
 */
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

/** OTP costs real money per message, so this is tighter than the others. */
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

/**
 * Social sign-in reaches out to Google or Apple on every call, so an unbounded
 * endpoint lets anyone spend our request quota with those providers and stall
 * real sign-ins behind it.
 */
export const socialSignInRateLimit = build({
  name: 'social-signin',
  windowMs: 15 * 60 * 1000,
  limit: 20,
});

/** Token rotation. Bounded so a leaked token cannot be used to hammer the API. */
export const refreshRateLimit = build({
  name: 'refresh',
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

/**
 * The floor under every versioned route, mounted in app.ts.
 *
 * Without this, any endpoint that has no specific limiter has no ceiling at
 * all. Routes that need tighter bounds add their own on top; this exists so
 * that forgetting to is not a hole.
 *
 * Deliberately not applied to /health, which load balancers poll continuously.
 */
export const generalRateLimit = build({
  name: 'general',
  windowMs: 15 * 60 * 1000,
  limit: env.RATE_LIMIT_GENERAL_MAX,
});

/**
 * Starting a video call (Batch 14).
 *
 * The general limiter allows RATE_LIMIT_GENERAL_MAX requests per quarter hour,
 * which for this endpoint means ringing someone's phone that many times.
 * Starting a call is one of
 * very few actions that makes another person's device demand attention
 * immediately, so it gets its own ceiling.
 *
 * Keyed on the CALLER'S ACCOUNT, not their IP. Mobile users sit behind carrier
 * NAT in large groups, so an IP bucket would throttle strangers together and
 * still leave one account free to spam from several addresses. The abuse here
 * is an account behaviour.
 *
 * Ten in five minutes is far above any real use — a person redialling a dropped
 * call a few times stays well inside it — and far below what would be needed to
 * harass somebody.
 */
export const callStartRateLimit = build({
  name: 'call-start',
  windowMs: 5 * 60 * 1000,
  limit: 10,
  key: (req) => `user:${req.user?.id ?? `ip:${clientIp(req)}`}`,
  message: 'You are starting calls too quickly. Please wait a moment.',
});
