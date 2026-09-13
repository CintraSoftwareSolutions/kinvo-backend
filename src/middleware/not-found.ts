import type { RequestHandler } from 'express';

import { ApiError } from '@utils/api-error';

/**
 * Terminal route. Unmatched paths must still produce the spec 4.2 envelope —
 * Express's default HTML 404 page would break the client's parser.
 */
export const notFound: RequestHandler = (_req, _res, next) => {
  next(ApiError.notFound('That endpoint does not exist.'));
};
