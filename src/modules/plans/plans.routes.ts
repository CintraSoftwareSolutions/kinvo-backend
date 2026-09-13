import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireOnboarded } from '@middleware/require-onboarded';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './plans.controller';
import {
  cancelSchema,
  createPlanSchema,
  listPlansQuerySchema,
  planIdParamSchema,
  respondSchema,
  sharePlanSchema,
  updatePlanSchema,
} from './plans.schema';

/**
 * Plan routes (spec §7, §5.8, Batch 12).
 *
 * Every plan belongs to a match, so `requireOnboarded` throughout — a pending
 * account has no matches and therefore nothing to plan.
 */
export const plansRouter: Router = Router();

plansRouter.use(authenticate, requireOnboarded);

plansRouter.get('/', validate({ query: listPlansQuerySchema }), asyncHandler(controller.listPlans));

plansRouter.post('/', validate({ body: createPlanSchema }), asyncHandler(controller.createPlan));

plansRouter.get('/:id', validate({ params: planIdParamSchema }), asyncHandler(controller.getPlan));

plansRouter.patch(
  '/:id',
  validate({ params: planIdParamSchema, body: updatePlanSchema }),
  asyncHandler(controller.updatePlan),
);

/** Draft to proposed — the only way the other person learns it exists. */
plansRouter.post(
  '/:id/propose',
  validate({ params: planIdParamSchema }),
  asyncHandler(controller.proposePlan),
);

plansRouter.post(
  '/:id/respond',
  validate({ params: planIdParamSchema, body: respondSchema }),
  asyncHandler(controller.respondToPlan),
);

plansRouter.post(
  '/:id/cancel',
  validate({ params: planIdParamSchema, body: cancelSchema }),
  asyncHandler(controller.cancelPlan),
);

plansRouter.post(
  '/:id/share',
  validate({ params: planIdParamSchema, body: sharePlanSchema }),
  asyncHandler(controller.sharePlan),
);
