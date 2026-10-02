import type { RequestHandler } from 'express';

import { ApiError } from '@utils/api-error';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(ApiError.notFound('That endpoint does not exist.'));
};
