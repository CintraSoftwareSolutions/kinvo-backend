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

/**
 * Moderation routes (spec §7, Batch 10).
 *
 * The check is deliberately NOT behind `requireOnboarded`: a bio written during
 * onboarding is exactly the kind of content that should be checked, and gating
 * it on a completed onboarding would leave the first thing a user writes
 * unchecked.
 */
export const moderationRouter: Router = Router();

moderationRouter.use(authenticate);

/**
 * spec §5.4: a separate pre-send endpoint, so the client can show the warning
 * dialog before committing. Always answers `can_send: true` — it advises, it
 * does not refuse.
 */
moderationRouter.post(
  '/check',
  validate({ body: checkContentSchema }),
  asyncHandler(controller.checkContent),
);

/**
 * The moderation team's queue. Behind a role gate rather than a block-style
 * 404: admin surfaces are a documented part of the API and there is nothing to
 * conceal about their existence.
 */
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
