import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './settings.controller';
import { deviceIdParamSchema, snoozeSchema, updateSettingsSchema } from './settings.schema';

/** Settings and connected devices (spec §7, Batch 5). */
export const settingsRouter: Router = Router();

settingsRouter.use(authenticate);

settingsRouter.get('/', asyncHandler(controller.getSettings));

settingsRouter.patch(
  '/',
  validate({ body: updateSettingsSchema }),
  asyncHandler(controller.updateSettings),
);

settingsRouter.post('/snooze', validate({ body: snoozeSchema }), asyncHandler(controller.snooze));

settingsRouter.delete('/snooze', asyncHandler(controller.unsnooze));

export const devicesRouter: Router = Router();

devicesRouter.use(authenticate);

devicesRouter.get('/', asyncHandler(controller.listDevices));

// Before /:id, or "others" is read as a device id.
devicesRouter.delete('/others', asyncHandler(controller.revokeOtherDevices));

devicesRouter.delete(
  '/:id',
  validate({ params: deviceIdParamSchema }),
  asyncHandler(controller.revokeDevice),
);
