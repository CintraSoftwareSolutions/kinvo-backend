import { Redis } from 'ioredis';

import { env, isProduction, isTest } from '@config/env';
import { logger } from '@utils/logger';

/**
 * Redis is cache and queue, never the system of record.
 *
 * Rate-limit counters live here so limits are shared across server instances —
 * a per-process counter multiplies the real limit by the number of instances,
 * which is the same as having no limit. Quota counters (Batch 6) and BullMQ
 * (Batch 7) join later.
 *
 * If Redis is wiped, the product degrades: everyone gets a fresh rate-limit
 * window. It does not lose data. That is an accepted, deliberate trade.
 */

function createClient(): Redis {
  const client = new Redis(env.REDIS_URL, {
    // Fail fast rather than queueing commands forever behind a dead server.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: !isTest,
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
  });

  client.on('error', (error: Error) => {
    // Logged, not thrown: a Redis outage must degrade rate limiting, never take
    // the API down.
    logger.error({ err: error }, 'redis error');
  });

  return client;
}

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis: Redis = globalForRedis.redis ?? createClient();

if (!isProduction) {
  // tsx watch re-imports on every save; without this each reload opens another
  // connection until Redis refuses new ones.
  globalForRedis.redis = redis;
}

export async function connectRedis(): Promise<void> {
  if (redis.status === 'ready' || redis.status === 'connecting') {
    return;
  }
  await redis.connect();
  logger.info('redis connected');
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.info('redis disconnected');
}

export async function isRedisReachable(): Promise<boolean> {
  try {
    const reply = await redis.ping();
    return reply === 'PONG';
  } catch (error) {
    logger.error({ err: error }, 'redis health check failed');
    return false;
  }
}
