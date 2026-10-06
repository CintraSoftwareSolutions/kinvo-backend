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

async function start(): Promise<Server> {
  await connectDatabase();
  await connectRedis();
  await startJobs();

  const listening = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { port: env.PORT, host: env.HOST, environment: env.NODE_ENV, api_prefix: API_PREFIX },
      'kinvo api listening',
    );
  });
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
  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  const closeConnections = async (): Promise<void> => {
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

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  process.exit(1);
});

export { server };
