import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { API_PREFIX } from '@config/constants';
import { env } from '@config/env';
import { errorHandler } from '@middleware/error-handler';
import { notFound } from '@middleware/not-found';
import { generalRateLimit } from '@middleware/rate-limit';
import { requestId } from '@middleware/request-id';
import { requestLogger } from '@middleware/request-logger';
import { healthRouter } from '@modules/health/health.routes';
import { apiRouter } from '@/routes';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.includes('*') ? true : env.CORS_ORIGINS,
      credentials: false,
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    }),
  );
  app.use(compression());

  app.use(`${API_PREFIX}/webhooks/video`, express.raw({ type: '*/*', limit: env.JSON_BODY_LIMIT }));

  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

  app.use(express.urlencoded({ extended: true, limit: env.JSON_BODY_LIMIT }));

  app.use(requestLogger);

  app.use('/health', healthRouter);

  app.use(API_PREFIX, generalRateLimit, apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
