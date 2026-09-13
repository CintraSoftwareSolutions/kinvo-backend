import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

import { env, isProduction, isTest } from '@config/env';
import { logger } from '@utils/logger';

/**
 * The single point of contact with the generated Prisma client.
 *
 * Prisma 7 emits the client into `generated/` in the project tree rather than
 * into node_modules, so that path is imported exactly once — here. Everything
 * else in the codebase imports from `@/db/prisma`, which keeps the generated
 * location an implementation detail we can move without touching call sites.
 */

/**
 * Query logging is opt-in at LOG_LEVEL=trace rather than on by default in
 * development — every seed run and every request would otherwise bury useful
 * output under raw SQL.
 */
const log: ('query' | 'info' | 'warn' | 'error')[] = isProduction
  ? ['warn', 'error']
  : isTest
    ? // Silent under test. Constraint violations are the assertion in many
      // integration tests, so logging them prints alarming output for passing runs.
      []
    : env.LOG_LEVEL === 'trace'
      ? ['query', 'warn', 'error']
      : ['warn', 'error'];

function createClient(): PrismaClient {
  // Prisma 7 connects through a driver adapter rather than a URL on the client.
  // The connection string comes from our own validated env, so a malformed one
  // fails at boot with our error rather than Prisma's ambient lookup.
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

  return new PrismaClient({ adapter, log });
}

/**
 * `tsx watch` re-imports modules on every save. Without caching the client on
 * globalThis, each reload opens a new connection pool and Postgres runs out of
 * connections within a few minutes of development.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('database disconnected');
}

/**
 * Cheap liveness probe for the readiness endpoint. Returns false rather than
 * throwing — the caller decides what an unreachable database means.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'database health check failed');
    return false;
  }
}

// Re-exported so no module outside src/db needs to know where the client lives.
export { Prisma } from '../generated/prisma/client';
export * from '../generated/prisma/enums';
export type * from '../generated/prisma/models';
