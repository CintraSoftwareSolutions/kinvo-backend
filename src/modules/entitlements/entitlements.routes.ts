import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './entitlements.controller';

/**
 * Entitlement routes (spec §7, Batch 6).
 *
 * Authenticated but not behind `requireOnboarded`: the app reads entitlements
 * to decide what to render, including during onboarding.
 */
export const entitlementsRouter: Router = Router();

entitlementsRouter.use(authenticate);

entitlementsRouter.get('/entitlements', asyncHandler(controller.getMyEntitlements));
