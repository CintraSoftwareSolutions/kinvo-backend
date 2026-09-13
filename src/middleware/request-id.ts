import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { REQUEST_ID_HEADER, REQUEST_ID_MAX_LENGTH } from '@config/constants';
import { logger } from '@utils/logger';

/**
 * Correlates every log line for a request. Honours an inbound X-Request-Id so a
 * trace survives the load balancer, but bounds its length — the value is echoed
 * back in a response header and must not become an injection vector.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header(REQUEST_ID_HEADER);
  const isUsable =
    typeof inbound === 'string' &&
    inbound.length > 0 &&
    inbound.length <= REQUEST_ID_MAX_LENGTH &&
    /^[\w.:-]+$/.test(inbound);

  const id = isUsable ? inbound : randomUUID();

  req.id = id;
  req.log = logger.child({ request_id: id });
  res.setHeader('X-Request-Id', id);

  next();
};
