import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireOnboarded } from '@middleware/require-onboarded';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './chat.controller';
import {
  conversationIdParamSchema,
  listQuerySchema,
  messagesQuerySchema,
  sendMessageSchema,
  updateConversationSchema,
} from './chat.schema';

export const chatRouter: Router = Router();

chatRouter.use(authenticate, requireOnboarded);

chatRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(controller.listConversations),
);

chatRouter.get('/unread-count', asyncHandler(controller.unreadTotal));

chatRouter.get(
  '/:id',
  validate({ params: conversationIdParamSchema }),
  asyncHandler(controller.getConversation),
);

chatRouter.patch(
  '/:id',
  validate({ params: conversationIdParamSchema, body: updateConversationSchema }),
  asyncHandler(controller.updateConversation),
);

chatRouter.get(
  '/:id/messages',
  validate({ params: conversationIdParamSchema, query: messagesQuerySchema }),
  asyncHandler(controller.listMessages),
);

chatRouter.post(
  '/:id/messages',
  validate({ params: conversationIdParamSchema, body: sendMessageSchema }),
  asyncHandler(controller.sendMessage),
);

chatRouter.post(
  '/:id/read',
  validate({ params: conversationIdParamSchema }),
  asyncHandler(controller.markRead),
);
