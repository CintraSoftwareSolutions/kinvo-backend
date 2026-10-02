import type { RequestHandler } from 'express';

export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const payload = {
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      platform: req.header('x-platform') ?? null,
      app_version: req.header('x-app-version') ?? null,
    };

    if (res.statusCode >= 500) {
      req.log.error(payload, 'request failed');
    } else if (res.statusCode >= 400) {
      req.log.warn(payload, 'request rejected');
    } else {
      req.log.info(payload, 'request completed');
    }
  });

  next();
};
