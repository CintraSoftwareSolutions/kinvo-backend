import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './entitlements.controller';
export const entitlementsRouter: Router = Router();

entitlementsRouter.use(authenticate);

entitlementsRouter.get('/entitlements', asyncHandler(controller.getMyEntitlements));
