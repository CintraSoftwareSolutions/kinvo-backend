import express, { type Express } from 'express';
import supertest from 'supertest';

import { UserStatus, prisma } from '@/db/prisma';
import { authenticate, optionalAuth, requireUser } from '@middleware/authenticate';
import { errorHandler } from '@middleware/error-handler';
import { requireOnboarded } from '@middleware/require-onboarded';
import { requireRole } from '@middleware/require-role';
import { setRateLimitingDisabled, loginRateLimit } from '@middleware/rate-limit';
import { sendSuccess } from '@utils/response';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { authHeader, bearer, createAuthenticatedUser } from '../helpers/auth';
import { expectErrorEnvelope } from '../helpers/request';

/**
 * The middleware every later batch mounts. Tested against a throwaway app so
 * these assertions do not depend on any particular endpoint existing.
 */

function buildApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/protected', authenticate, (req, res) => {
    sendSuccess(res, { user_id: requireUser(req).id });
  });

  app.get('/optional', optionalAuth, (req, res) => {
    sendSuccess(res, { authenticated: Boolean(req.user), user_id: req.user?.id ?? null });
  });

  app.get('/onboarded', authenticate, requireOnboarded, (_req, res) => {
    sendSuccess(res, { allowed: true });
  });

  app.get('/admin', authenticate, requireRole('admin'), (_req, res) => {
    sendSuccess(res, { allowed: true });
  });

  app.get('/staff', authenticate, requireRole('admin', 'moderator'), (_req, res) => {
    sendSuccess(res, { allowed: true });
  });

  app.use(errorHandler);
  return app;
}

const client = supertest(buildApp());

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('authenticate', () => {
  it('attaches the user to the request', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    const response = await client.get('/protected').set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.user_id).toBe(userId);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await client.get('/protected');

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('optionalAuth', () => {
  it('passes through anonymously with no token', async () => {
    const response = await client.get('/optional');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ authenticated: false, user_id: null });
  });

  it('attaches the user when a valid token is present', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    const response = await client.get('/optional').set(authHeader(tokens));

    expect(response.body.data).toEqual({ authenticated: true, user_id: userId });
  });

  it('degrades to anonymous on a bad token rather than erroring', async () => {
    // These routes work signed out, so a stale token should give the anonymous
    // experience, not turn a public page into an error.
    const response = await client.get('/optional').set(bearer('not-a-real-token'));

    expect(response.status).toBe(200);
    expect(response.body.data.authenticated).toBe(false);
  });

  it('still surfaces a suspension', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    await prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.suspended },
    });

    const response = await client.get('/optional').set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ACCOUNT_SUSPENDED');
  });
});

describe('requireOnboarded (spec §5.1)', () => {
  it('allows an active, onboarded user', async () => {
    const { tokens } = await createAuthenticatedUser({ onboarded: true });

    const response = await client.get('/onboarded').set(authHeader(tokens));

    expect(response.status).toBe(200);
  });

  it('blocks a pending user with ONBOARDING_INCOMPLETE', async () => {
    const { tokens } = await createAuthenticatedUser({
      status: UserStatus.pending,
      onboarded: false,
    });

    const response = await client.get('/onboarded').set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ONBOARDING_INCOMPLETE');
  });

  it('blocks an active user who never finished onboarding', async () => {
    const { tokens } = await createAuthenticatedUser({
      status: UserStatus.active,
      onboarded: false,
    });

    const response = await client.get('/onboarded').set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ONBOARDING_INCOMPLETE');
  });

  it('blocks the account a social or phone signup creates', async () => {
    // This is the gate that keeps a user with no date of birth out of the
    // product until onboarding runs the under-18 check (spec §5.1).
    const { tokens } = await createAuthenticatedUser({
      status: UserStatus.pending,
      onboarded: false,
      date_of_birth: null,
    });

    const response = await client.get('/onboarded').set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ONBOARDING_INCOMPLETE');
  });
});

describe('requireRole', () => {
  it('allows a matching role', async () => {
    const { tokens } = await createAuthenticatedUser({ role: 'admin' });

    const response = await client.get('/admin').set(authHeader(tokens));

    expect(response.status).toBe(200);
  });

  it('refuses an ordinary user with FORBIDDEN', async () => {
    const { tokens } = await createAuthenticatedUser({ role: 'user' });

    const response = await client.get('/admin').set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'FORBIDDEN');
  });

  it('refuses a moderator on an admin-only route', async () => {
    const { tokens } = await createAuthenticatedUser({ role: 'moderator' });

    const response = await client.get('/admin').set(authHeader(tokens));

    expect(response.status).toBe(403);
  });

  it('accepts any of several allowed roles', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const admin = await createAuthenticatedUser({ role: 'admin' });

    expect((await client.get('/staff').set(authHeader(moderator.tokens))).status).toBe(200);
    expect((await client.get('/staff').set(authHeader(admin.tokens))).status).toBe(200);
  });

  it('requires authentication first', async () => {
    const response = await client.get('/admin');

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('rate limiting (spec §4.9)', () => {
  // Off by default under test; switched on only here.
  beforeAll(() => setRateLimitingDisabled(false));
  afterAll(() => setRateLimitingDisabled(true));

  function buildLimitedApp(): Express {
    const app = express();
    app.use(express.json());
    app.post('/login', loginRateLimit, (_req, res) => sendSuccess(res, { ok: true }));
    app.use(errorHandler);
    return app;
  }

  it('returns 429 RATE_LIMITED with retry context, never 422', async () => {
    const limited = supertest(buildLimitedApp());
    const email = `ratelimit.${Date.now()}@kinvo.test`;

    let blocked: { status: number; body: Record<string, never> } | null = null;

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await limited.post('/login').send({ email, password: 'x' });
      if (response.status === 429) {
        blocked = response as never;
        break;
      }
    }

    expect(blocked).not.toBeNull();
    expectErrorEnvelope(blocked!.body, 'RATE_LIMITED');

    // Infrastructure protection is 429. A business quota would be 422 with
    // paywall context — conflating them hides the paywall (spec §4.9).
    expect(blocked!.status).toBe(429);
  });

  it('counts per account, so one attacker cannot lock out everyone', async () => {
    const limited = supertest(buildLimitedApp());
    const victim = `victim.${Date.now()}@kinvo.test`;
    const bystander = `bystander.${Date.now()}@kinvo.test`;

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await limited.post('/login').send({ email: victim, password: 'x' });
    }

    const other = await limited.post('/login').send({ email: bystander, password: 'x' });

    expect(other.status).toBe(200);
  });

  it('sets the X-RateLimit-* headers the spec names, on every response', async () => {
    const limited = supertest(buildLimitedApp());

    const response = await limited
      .post('/login')
      .send({ email: `headers.${Date.now()}@kinvo.test`, password: 'x' });

    // Spec §4.9 names these explicitly — they are what the Flutter app reads.
    expect(response.headers).toHaveProperty('x-ratelimit-limit');
    expect(response.headers).toHaveProperty('x-ratelimit-remaining');
    expect(response.headers).toHaveProperty('x-ratelimit-reset');

    // The draft-7 standard header rides alongside for compliant tooling.
    expect(response.headers).toHaveProperty('ratelimit');
  });

  it('sends Retry-After once a caller is limited', async () => {
    const limited = supertest(buildLimitedApp());
    const email = `retryafter.${Date.now()}@kinvo.test`;

    let blocked: { status: number; headers: Record<string, string> } | null = null;

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await limited.post('/login').send({ email, password: 'x' });
      if (response.status === 429) {
        blocked = response as never;
        break;
      }
    }

    expect(blocked).not.toBeNull();
    expect(blocked!.headers).toHaveProperty('retry-after');
  });
});
