import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './subscriptions.controller';

/**
 * Subscription routes (spec §7, §5.10).
 *
 * Both are READS. There is no endpoint here that starts a purchase or changes
 * entitlement, because taking the payment is not this codebase's job — and an
 * endpoint that granted access on request is exactly what §5.10 forbids.
 */
export const subscriptionsRouter: Router = Router();

/** Public: the paywall is shown before anyone signs in on some screens. */
subscriptionsRouter.get('/products', asyncHandler(controller.listProducts));

subscriptionsRouter.use(authenticate);

subscriptionsRouter.get('/me', asyncHandler(controller.getMySubscription));
