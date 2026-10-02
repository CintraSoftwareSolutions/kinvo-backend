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

export const callsRouter: Router = Router();

callsRouter.use(authenticate, requireOnboarded);

callsRouter.get('/', validate({ query: listCallsQuerySchema }), asyncHandler(controller.listCalls));

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

export const callsWebhookRouter: Router = Router();

callsWebhookRouter.post('/video', asyncHandler(controller.handleVideoWebhook));
