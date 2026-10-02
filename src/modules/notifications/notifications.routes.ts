import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './notifications.controller';
import {
  categoryParamSchema,
  listQuerySchema,
  notificationIdParamSchema,
  registerPushTokenSchema,
  updatePreferenceSchema,
} from './notifications.schema';

export const notificationsRouter: Router = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(controller.listNotifications),
);

notificationsRouter.get('/unread-count', asyncHandler(controller.unreadCount));

notificationsRouter.get('/badges', asyncHandler(controller.badges));

notificationsRouter.post('/read-all', asyncHandler(controller.markAllRead));

notificationsRouter.get('/preferences', asyncHandler(controller.listPreferences));

notificationsRouter.patch(
  '/preferences/:category',
  validate({ params: categoryParamSchema, body: updatePreferenceSchema }),
  asyncHandler(controller.updatePreference),
);

notificationsRouter.post(
  '/tokens',
  validate({ body: registerPushTokenSchema }),
  asyncHandler(controller.registerPushToken),
);

notificationsRouter.delete('/tokens/:device_id', asyncHandler(controller.unregisterPushToken));

notificationsRouter.post(
  '/:id/read',
  validate({ params: notificationIdParamSchema }),
  asyncHandler(controller.markRead),
);
