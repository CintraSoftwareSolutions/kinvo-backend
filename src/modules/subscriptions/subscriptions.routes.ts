import { type RequestHandler, Router } from 'express';

import { testPurchasesEnabled } from '@config/env';
import { authenticate } from '@middleware/authenticate';
import { notFound } from '@middleware/not-found';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './subscriptions.controller';
import { testPurchaseSchema } from './subscriptions.schema';

export const subscriptionsRouter: Router = Router();

const requireTestPurchases: RequestHandler = (req, res, next) => {
  if (testPurchasesEnabled()) {
    next();
    return;
  }

  notFound(req, res, next);
};

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
