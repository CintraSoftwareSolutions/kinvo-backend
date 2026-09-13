import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireOnboarded } from '@middleware/require-onboarded';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './matches.controller';
import { listMatchesQuerySchema, matchIdParamSchema } from './matches.schema';

/**
 * Match routes (spec §7, Batch 8).
 *
 * `requireOnboarded` on every route: matching is part of the product proper,
 * and an account that has not passed the under-18 check must not reach it.
 *
 * There is no POST — matches are created by mutual likes in the discovery
 * module and can be created no other way.
 */
export const matchesRouter: Router = Router();

matchesRouter.use(authenticate, requireOnboarded);

matchesRouter.get(
  '/',
  validate({ query: listMatchesQuerySchema }),
  asyncHandler(controller.listMatches),
);

matchesRouter.get(
  '/:id',
  validate({ params: matchIdParamSchema }),
  asyncHandler(controller.getMatch),
);

matchesRouter.delete(
  '/:id',
  validate({ params: matchIdParamSchema }),
  asyncHandler(controller.unmatch),
);

matchesRouter.post(
  '/:id/extend',
  validate({ params: matchIdParamSchema }),
  asyncHandler(controller.extendMatch),
);
