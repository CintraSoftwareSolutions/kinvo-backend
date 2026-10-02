import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireRole } from '@middleware/require-role';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './moderation.controller';
import {
  checkContentSchema,
  flagIdParamSchema,
  listFlagsQuerySchema,
  resolveFlagSchema,
} from './moderation.schema';

export const moderationRouter: Router = Router();

moderationRouter.use(authenticate);

moderationRouter.post(
  '/check',
  validate({ body: checkContentSchema }),
  asyncHandler(controller.checkContent),
);

moderationRouter.get(
  '/flags',
  requireRole('moderator', 'admin'),
  validate({ query: listFlagsQuerySchema }),
  asyncHandler(controller.listFlags),
);

moderationRouter.patch(
  '/flags/:id',
  requireRole('moderator', 'admin'),
  validate({ params: flagIdParamSchema, body: resolveFlagSchema }),
  asyncHandler(controller.resolveFlag),
);
