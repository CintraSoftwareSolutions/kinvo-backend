import express, { type Express } from 'express';
import supertest from 'supertest';

import { API_PREFIX } from '@config/constants';
import { errorHandler } from '@middleware/error-handler';
import { notFound } from '@middleware/not-found';
import { requestId } from '@middleware/request-id';
import { requestLogger } from '@middleware/request-logger';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { asyncHandler } from '@utils/async-handler';
import { api, expectErrorEnvelope } from '../helpers/request';

/**
 * Routes that fail on purpose. Built as a throwaway app rather than mounted on
 * the real one — the production app must never ship a route whose job is to
 * crash.
 */
function buildFaultyApp(): Express {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use(requestLogger);

  app.get('/sync-boom', () => {
    throw new Error('kaboom: connection string postgres://user:hunter2@db/kinvo');
  });

  app.get(
    '/async-boom',
    asyncHandler(async () => {
      await Promise.resolve();
      throw new Error('async kaboom');
    }),
  );

  app.get('/api-error', () => {
    throw new ApiError(ERROR_CODES.QUOTA_EXCEEDED, "You've used all your likes for today.", {
      quota_type: 'daily_swipes',
      limit: 50,
      used: 50,
      resets_at: '2026-08-14T00:00:00Z',
      upgrade_available: true,
    });
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('error handling', () => {
  describe('on the real app', () => {
    it('returns a 404 envelope for an unknown route', async () => {
      const response = await api.get(`${API_PREFIX}/does-not-exist`);

      expect(response.status).toBe(404);
      expectErrorEnvelope(response.body, 'NOT_FOUND');
      expect(response.body.error.details).toBeNull();
    });

    it('returns a 404 envelope for an unknown unversioned route', async () => {
      const response = await api.post('/nope');

      expect(response.status).toBe(404);
      expectErrorEnvelope(response.body, 'NOT_FOUND');
    });

    it('rejects malformed JSON as BAD_REQUEST, not a stack trace', async () => {
      const response = await api
        .post(`${API_PREFIX}/health`)
        .set('Content-Type', 'application/json')
        .send('{"broken":');

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'BAD_REQUEST');
    });

    it('rejects an oversized body with 413 FILE_TOO_LARGE', async () => {
      const oversized = `{"blob":"${'x'.repeat(1_400_000)}"}`;

      const response = await api
        .post(`${API_PREFIX}/health`)
        .set('Content-Type', 'application/json')
        .send(oversized);

      expect(response.status).toBe(413);
      expectErrorEnvelope(response.body, 'FILE_TOO_LARGE');
    });
  });

  describe('on failing routes', () => {
    const faulty = supertest(buildFaultyApp());

    it('converts a thrown Error into a 500 envelope', async () => {
      const response = await faulty.get('/sync-boom');

      expect(response.status).toBe(500);
      expectErrorEnvelope(response.body, 'INTERNAL_ERROR');
    });

    it('never leaks the internal message, stack, or credentials', async () => {
      const response = await faulty.get('/sync-boom');
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('kaboom');
      expect(serialised).not.toContain('hunter2');
      expect(serialised).not.toContain('postgres://');
      expect(serialised).not.toMatch(/\bat .+\.ts:\d+/);
      expect(response.body.error.details).toBeNull();
    });

    it('catches rejected promises from async handlers', async () => {
      const response = await faulty.get('/async-boom');

      expect(response.status).toBe(500);
      expectErrorEnvelope(response.body, 'INTERNAL_ERROR');
    });

    it('preserves an ApiError code, message, status and paywall details', async () => {
      const response = await faulty.get('/api-error');

      // Spec 4.9: a business quota is 422 with upgrade context, never 429.
      expect(response.status).toBe(422);
      expectErrorEnvelope(response.body, 'QUOTA_EXCEEDED');
      expect(response.body.error.message).toBe("You've used all your likes for today.");
      expect(response.body.error.details).toEqual({
        quota_type: 'daily_swipes',
        limit: 50,
        used: 50,
        resets_at: '2026-08-14T00:00:00Z',
        upgrade_available: true,
      });
    });
  });
});
