import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './users.controller';
import {
  setDateOfBirthSchema,
  setInterestsSchema,
  setPromptsSchema,
  updateLocationSchema,
  updateProfileSchema,
  userIdParamSchema,
} from './users.schema';

export const usersRouter: Router = Router();

usersRouter.use(authenticate);

usersRouter.get('/me', asyncHandler(controller.getMe));

usersRouter.patch(
  '/me',
  validate({ body: updateProfileSchema }),
  asyncHandler(controller.updateMe),
);

usersRouter.patch(
  '/me/location',
  validate({ body: updateLocationSchema }),
  asyncHandler(controller.updateLocation),
);

usersRouter.put(
  '/me/interests',
  validate({ body: setInterestsSchema }),
  asyncHandler(controller.setInterests),
);

usersRouter.put(
  '/me/prompts',
  validate({ body: setPromptsSchema }),
  asyncHandler(controller.setPrompts),
);

usersRouter.get('/me/preview', asyncHandler(controller.getPreview));

usersRouter.delete('/me', asyncHandler(controller.deleteMe));

usersRouter.get(
  '/:id',
  validate({ params: userIdParamSchema }),
  asyncHandler(controller.getPublicProfile),
);

export const onboardingRouter: Router = Router();

onboardingRouter.use(authenticate);

onboardingRouter.get('/', asyncHandler(controller.getOnboarding));

onboardingRouter.post(
  '/date-of-birth',
  validate({ body: setDateOfBirthSchema }),
  asyncHandler(controller.setDateOfBirth),
);

onboardingRouter.post('/complete', asyncHandler(controller.completeOnboarding));
