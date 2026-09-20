import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { callStartRateLimit } from '@middleware/rate-limit';
import { requireOnboarded } from '@middleware/require-onboarded';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './calls.controller';
import {
  callIdParamSchema,
  listCallsQuerySchema,
  safetyActionSchema,
  startCallSchema,
} from './calls.schema';

/**
 * Call routes (spec §7, §5.7, Batch 14).
 *
 * `requireOnboarded` throughout: every call belongs to a match, and a pending
 * account has no matches. It is also the gate that keeps accounts with no date
 * of birth out of the product, which matters more here than almost anywhere —
 * this is the feature that puts two people on camera together.
 */
export const callsRouter: Router = Router();

callsRouter.use(authenticate, requireOnboarded);

callsRouter.get('/', validate({ query: listCallsQuerySchema }), asyncHandler(controller.listCalls));

// The limiter sits AFTER authenticate, because it counts per account rather
// than per IP — and it must run before the handler, so a throttled call never
// reaches the point of notifying anyone.
callsRouter.post(
  '/',
  callStartRateLimit,
  validate({ body: startCallSchema }),
  asyncHandler(controller.startCall),
);

callsRouter.post(
  '/:id/answer',
  validate({ params: callIdParamSchema }),
  asyncHandler(controller.answerCall),
);

callsRouter.post(
  '/:id/decline',
  validate({ params: callIdParamSchema }),
  asyncHandler(controller.declineCall),
);

callsRouter.post(
  '/:id/end',
  validate({ params: callIdParamSchema }),
  asyncHandler(controller.endCall),
);

/**
 * Re-issues a token for a live call.
 *
 * A GET that mints a credential, which is unusual enough to justify: it is
 * idempotent, carries no body, and returns the same short-lived grant the
 * client already holds. The permission check runs again on every call, so a
 * block placed mid-call stops the next reconnect.
 */
callsRouter.get(
  '/:id/token',
  validate({ params: callIdParamSchema }),
  asyncHandler(controller.issueToken),
);

callsRouter.post(
  '/:id/safety',
  validate({ params: callIdParamSchema, body: safetyActionSchema }),
  asyncHandler(controller.recordSafetyAction),
);

/**
 * The video provider's status callback.
 *
 * Mounted apart from `callsRouter` on purpose: that router applies
 * `authenticate` and `requireOnboarded` to everything under it, and the
 * provider carries no bearer token and is not a user. Its signature is the
 * authentication, checked in the controller before any field is read.
 */
export const callsWebhookRouter: Router = Router();

callsWebhookRouter.post('/video', asyncHandler(controller.handleVideoWebhook));
