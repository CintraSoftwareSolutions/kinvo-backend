import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireOnboarded } from '@middleware/require-onboarded';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './matches.controller';
import { listMatchesQuerySchema, matchIdParamSchema } from './matches.schema';

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
