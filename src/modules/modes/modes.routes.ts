import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './modes.controller';
import { modeParamSchema, updateModeSchema } from './modes.schema';

/**
 * Mode routes (spec §7, Batch 5).
 *
 * Authenticated but deliberately NOT behind requireOnboarded: enabling a mode
 * is part of onboarding, so gating it on a completed onboarding would deadlock.
 */
export const modesRouter: Router = Router();

modesRouter.use(authenticate);

modesRouter.get('/', asyncHandler(controller.listModes));

modesRouter.get('/:mode', validate({ params: modeParamSchema }), asyncHandler(controller.getMode));

modesRouter.patch(
  '/:mode',
  validate({ params: modeParamSchema, body: updateModeSchema }),
  asyncHandler(controller.updateMode),
);

modesRouter.post(
  '/:mode/primary',
  validate({ params: modeParamSchema }),
  asyncHandler(controller.setPrimaryMode),
);
