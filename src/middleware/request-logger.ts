import type { RequestHandler } from 'express';

/**
 * One structured line per completed request.
 *
 * Spec 15: no PII in logs. We log `req.path`, never `req.originalUrl` — query
 * strings can carry emails, tokens, and reset codes.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const payload = {
      method: req.method,
      // `baseUrl + path` is the full route without the query string.
      //
      // `req.path` alone is relative to whichever router matched, so a request
      // to /api/v1/health logs as "/" — every line looks identical and the logs
      // stop being useful the moment you need them. `req.originalUrl` would
      // give the full path but drags the query string in with it, and query
      // strings carry emails and reset tokens (spec §15).
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
