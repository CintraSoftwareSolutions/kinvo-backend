import { Router } from 'express';

import { getHealth, getReadiness } from '@modules/health/health.controller';
import { asyncHandler } from '@utils/async-handler';

export const healthRouter: Router = Router();

/** Liveness: is the process up? Checks nothing external. */
healthRouter.get('/', asyncHandler(getHealth));

/** Readiness: can it serve traffic? Checks Postgres and Redis. */
healthRouter.get('/ready', asyncHandler(getReadiness));
