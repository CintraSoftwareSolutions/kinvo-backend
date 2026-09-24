import { type RequestHandler, Router } from 'express';

import { testPurchasesEnabled } from '@config/env';
import { authenticate } from '@middleware/authenticate';
import { notFound } from '@middleware/not-found';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './subscriptions.controller';
import { testPurchaseSchema } from './subscriptions.schema';

/**
 * Subscription routes (spec §7, §5.10).
 *
 * The first two are READS. Taking a payment is not this codebase's job, and an
 * endpoint that granted access on request is exactly what §5.10 forbids.
 *
 * The exception is /test-purchase, and it is bounded: staging only, until
 * RevenueCat exists (test-purchases.service.ts, DECISIONS.md 24 Sep 2026).
 */
export const subscriptionsRouter: Router = Router();

/**
 * Shut unless test purchases are on — and shut means ABSENT. It hands over to
 * the same handler an unknown path reaches, so wherever this is off there is
 * nothing to find, byte for byte. Mounted after `authenticate`, like every
 * other path under /subscriptions, so a signed-out probe cannot tell it apart
 * either.
 */
const requireTestPurchases: RequestHandler = (req, res, next) => {
  if (testPurchasesEnabled()) {
    next();
    return;
  }

  notFound(req, res, next);
};

/** Public: the paywall is shown before anyone signs in on some screens. */
subscriptionsRouter.get('/products', asyncHandler(controller.listProducts));

subscriptionsRouter.use(authenticate);

subscriptionsRouter.get('/me', asyncHandler(controller.getMySubscription));

subscriptionsRouter.post(
  '/test-purchase',
  requireTestPurchases,
  validate({ body: testPurchaseSchema }),
  asyncHandler(controller.purchaseForTesting),
);

subscriptionsRouter.delete(
  '/test-purchase',
  requireTestPurchases,
  asyncHandler(controller.cancelTestPlan),
);
