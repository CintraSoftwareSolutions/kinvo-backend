import type { Request, Response } from 'express';

import { API_VERSION } from '@config/constants';
import { env } from '@config/env';
import { isDatabaseReachable } from '@/db/prisma';
import { isRedisReachable } from '@/db/redis';
import { isStorageReachable } from '@/providers/s3.provider';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { sendSuccess } from '@utils/response';

const startedAt = Date.now();

/**
 * Spec 4.12: liveness, no auth.
 *
 * Deliberately checks no dependency. A liveness probe that fails when Postgres
 * blips causes the orchestrator to kill healthy processes. Dependency health is
 * a separate question — see `getReadiness`.
 */
export function getHealth(_req: Request, res: Response): void {
  sendSuccess(res, {
    status: 'ok',
    api_version: API_VERSION,
    environment: env.NODE_ENV,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    // Spec 4.6: UTC ISO-8601 with Z, field name ends in _at.
    checked_at: new Date().toISOString(),
  });
}

/**
 * Readiness: can this process actually serve traffic?
 *
 * Distinct from liveness on purpose. A load balancer uses this to stop routing
 * to an instance that has lost its database, while the orchestrator keeps using
 * `/health` to decide whether the process itself is alive. Wiring both to the
 * same check makes a brief Postgres outage into a restart loop.
 *
 * Returns 503 when a dependency is down so the balancer reacts to the status
 * code rather than having to parse the body.
 */
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const [database, redis, storage] = await Promise.all([
    isDatabaseReachable(),
    isRedisReachable(),
    isStorageReachable(),
  ]);

  if (!database || !redis || !storage) {
    throw new ApiError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'This service is temporarily unavailable.',
      { database, redis, storage },
    );
  }

  sendSuccess(res, {
    status: 'ready',
    database,
    redis,
    // Added in Batch 4: with photos on every deck card, unreachable storage is
    // as fatal to the product as an unreachable database.
    storage,
    checked_at: new Date().toISOString(),
  });
}
