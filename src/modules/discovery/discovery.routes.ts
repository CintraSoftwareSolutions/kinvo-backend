import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireOnboarded } from '@middleware/require-onboarded';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './discovery.controller';
import { modeParamSchema, paginationQuerySchema, swipeBodySchema } from './discovery.schema';

/**
 * Discovery routes (spec §7, Batch 7).
 *
 * `requireOnboarded` is mounted on EVERY route here, not selectively. An
 * account created by social or phone sign-in has no date of birth until
 * onboarding runs the under-18 check, so letting one reach a deck is a legal
 * problem rather than a UX one.
 *
 * The mode is a path parameter throughout, so no request can reach a service
 * without one.
 */
export const discoveryRouter: Router = Router();

discoveryRouter.use(authenticate, requireOnboarded);

discoveryRouter.get(
  '/:mode/deck',
  validate({ params: modeParamSchema, query: paginationQuerySchema }),
  asyncHandler(controller.getDeck),
);

discoveryRouter.post(
  '/:mode/swipe',
  validate({ params: modeParamSchema, body: swipeBodySchema }),
  asyncHandler(controller.swipe),
);

discoveryRouter.post(
  '/:mode/rewind',
  validate({ params: modeParamSchema }),
  asyncHandler(controller.rewind),
);

discoveryRouter.get(
  '/:mode/likes-you',
  validate({ params: modeParamSchema, query: paginationQuerySchema }),
  asyncHandler(controller.likesYou),
);

discoveryRouter.post(
  '/:mode/boost',
  validate({ params: modeParamSchema }),
  asyncHandler(controller.startBoost),
);

discoveryRouter.get(
  '/:mode/stats',
  validate({ params: modeParamSchema }),
  asyncHandler(controller.stats),
);
