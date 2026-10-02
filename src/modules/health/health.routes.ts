import { Router } from 'express';

import { getHealth, getReadiness } from '@modules/health/health.controller';
import { asyncHandler } from '@utils/async-handler';

export const healthRouter: Router = Router();

healthRouter.get('/', asyncHandler(getHealth));

healthRouter.get('/ready', asyncHandler(getReadiness));
