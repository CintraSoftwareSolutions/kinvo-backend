import type { Server } from 'node:http';

import { app } from '@/app';
import { API_PREFIX } from '@config/constants';
import { env } from '@config/env';
import { connectDatabase, disconnectDatabase } from '@/db/prisma';
import { connectRedis, disconnectRedis } from '@/db/redis';
import { startJobs, stopJobs } from '@/jobs';
import { closeSocketServer, createSocketServer } from '@/realtime/socket.server';
import { logger } from '@utils/logger';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Open both connections before accepting traffic.
 *
 * Prisma and ioredis would both connect lazily on first use, but that turns a
 * bad connection string into a 500 on a user's first request instead of a
 * failure at deploy time — and a rolling deploy would happily replace healthy
 * instances with broken ones.
 */
async function start(): Promise<Server> {
  await connectDatabase();
  await connectRedis();
  // After Redis: BullMQ opens its own connections and needs one that works.
  await startJobs();

  const listening = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { port: env.PORT, host: env.HOST, environment: env.NODE_ENV, api_prefix: API_PREFIX },
      'kinvo api listening',
    );
  });

  // Attached to the same HTTP server, so realtime rides the port and TLS
  // termination the REST API already has. A separate port would need its own
  // load-balancer rule and its own certificate.
  createSocketServer(listening);

  return listening;
}

let server: Server | undefined;

void start()
  .then((listening) => {
    server = listening;
  })
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'failed to start');
    process.exit(1);
  });

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');

  // Force-exit if in-flight requests never drain, so orchestrators do not hang
  // on a stuck connection.
  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  const closeConnections = async (): Promise<void> => {
    // Only after the HTTP server has stopped accepting and drained, or we would
    // sever queries belonging to requests still in flight.
    // Sockets first: disconnecting clients while the database is still up lets
    // the disconnect handlers finish their presence writes. Then workers, so a
    // job in flight finishes against a live pool rather than one that closed
    // underneath it.
    await closeSocketServer();
    await stopJobs();
    await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
  };

  if (!server) {
    void closeConnections().finally(() => process.exit(0));
    return;
  }

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'error while closing server');
    }

    void closeConnections().finally(() => {
      logger.info('shutdown complete');
      process.exit(error ? 1 : 0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Spec 0.5: no unhandled promise rejections. Crash loudly rather than run on in
// an unknown state — the orchestrator restarts a clean process.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  process.exit(1);
});

export { server };
