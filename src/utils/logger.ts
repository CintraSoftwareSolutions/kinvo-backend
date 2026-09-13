import pino, { type Logger, type LoggerOptions } from 'pino';

import { SERVICE_NAME } from '@config/constants';
import { env, isDevelopment } from '@config/env';

/**
 * Spec 15: no PII in logs. Redaction is centralised here so it cannot be
 * forgotten at a call site.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'password',
  '*.password',
  '*.new_password',
  '*.current_password',
  'token',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'phone_number',
  '*.phone_number',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
};

/**
 * pino-pretty runs in a worker thread. Enabling it under Jest leaves the worker
 * open and the test run hangs, so it is development-only.
 */
export const logger: Logger = isDevelopment
  ? pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
    })
  : pino(options);
