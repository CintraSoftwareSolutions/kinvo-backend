import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireOnboarded } from '@middleware/require-onboarded';
import { requireRole } from '@middleware/require-role';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './safety.controller';
import {
  blockSchema,
  createContactSchema,
  createReportSchema,
  emergencySchema,
  idParamSchema,
  listQuerySchema,
  pingSchema,
  resolveReportSchema,
  reviewReportsQuerySchema,
  startSharingSchema,
  updateContactSchema,
  userIdParamSchema,
} from './safety.schema';

/**
 * Reports (spec §7, §5.7, Batch 12).
 *
 * Deliberately NOT behind `requireOnboarded`. Someone can be harassed by a
 * profile they saw during onboarding, and a safety route that first demands a
 * completed profile is a safety route that fails the person who needs it most.
 */
export const reportsRouter: Router = Router();

reportsRouter.use(authenticate);

reportsRouter.post(
  '/',
  validate({ body: createReportSchema }),
  asyncHandler(controller.createReport),
);

/** Reports this user FILED. There is no endpoint for reports about them. */
reportsRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(controller.listMyReports),
);

/**
 * The moderation queue — the only path that reveals a reporter's identity, and
 * the reason it is behind a role gate rather than the block-style 404.
 */
reportsRouter.get(
  '/review',
  requireRole('moderator', 'admin'),
  validate({ query: reviewReportsQuerySchema }),
  asyncHandler(controller.listReportsForReview),
);

reportsRouter.patch(
  '/:id',
  requireRole('moderator', 'admin'),
  validate({ params: idParamSchema, body: resolveReportSchema }),
  asyncHandler(controller.resolveReport),
);

/** Blocks (spec §5.5). Also not gated on onboarding, for the same reason. */
export const blocksRouter: Router = Router();

blocksRouter.use(authenticate);

blocksRouter.get('/', validate({ query: listQuerySchema }), asyncHandler(controller.listBlocks));

blocksRouter.post('/', validate({ body: blockSchema }), asyncHandler(controller.block));

blocksRouter.delete(
  '/:user_id',
  validate({ params: userIdParamSchema }),
  asyncHandler(controller.unblock),
);

/**
 * Trusted contacts, live location, and emergency (spec §5.7).
 *
 * `requireOnboarded` here: these attach to plans and matches, which a pending
 * account cannot have. Reports and blocks above are the exception because they
 * protect someone rather than extend the product.
 */
export const safetyRouter: Router = Router();

safetyRouter.use(authenticate, requireOnboarded);

safetyRouter.get('/contacts', asyncHandler(controller.listContacts));

safetyRouter.post(
  '/contacts',
  validate({ body: createContactSchema }),
  asyncHandler(controller.createContact),
);

safetyRouter.patch(
  '/contacts/:id',
  validate({ params: idParamSchema, body: updateContactSchema }),
  asyncHandler(controller.updateContact),
);

safetyRouter.delete(
  '/contacts/:id',
  validate({ params: idParamSchema }),
  asyncHandler(controller.deleteContact),
);

/** Literal path first, so it is never parsed as a session id. */
safetyRouter.get('/location/active', asyncHandler(controller.activeSession));

safetyRouter.post(
  '/location',
  validate({ body: startSharingSchema }),
  asyncHandler(controller.startSharing),
);

safetyRouter.delete(
  '/location/:id',
  validate({ params: idParamSchema }),
  asyncHandler(controller.stopSharing),
);

safetyRouter.post(
  '/location/:id/ping',
  validate({ params: idParamSchema, body: pingSchema }),
  asyncHandler(controller.recordPing),
);

safetyRouter.get(
  '/location/:id/trail',
  validate({ params: idParamSchema }),
  asyncHandler(controller.readTrail),
);

safetyRouter.post(
  '/emergency',
  validate({ body: emergencySchema }),
  asyncHandler(controller.raiseEmergency),
);

safetyRouter.get('/emergency', asyncHandler(controller.listEmergencies));
