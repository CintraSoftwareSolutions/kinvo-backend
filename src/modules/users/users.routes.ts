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

/**
 * Profile and account routes (spec §7, Batch 3).
 *
 * Everything here is behind `authenticate` but NOT `requireOnboarded` — a
 * pending user must be able to read and edit their own profile, or they could
 * never finish onboarding. `requireOnboarded` guards discovery, matching, and
 * chat from Batch 7 onward.
 *
 * The one exception is `GET /users/:id`: viewing someone else is part of the
 * product proper, so it requires a completed profile as well as a token.
 */
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

/**
 * Someone else's profile. The service applies the shared block exclusion clause
 * and returns 404 — never 403 — when a block, suspension, or deletion is the
 * reason (spec §4.4, §5.5).
 *
 * Declared last so `/me` and `/me/*` are matched first and a literal "me" can
 * never be parsed as a user id.
 */
usersRouter.get(
  '/:id',
  validate({ params: userIdParamSchema }),
  asyncHandler(controller.getPublicProfile),
);

/** Onboarding lives on its own path but is part of the users module. */
export const onboardingRouter: Router = Router();

onboardingRouter.use(authenticate);

onboardingRouter.get('/', asyncHandler(controller.getOnboarding));

onboardingRouter.post(
  '/date-of-birth',
  validate({ body: setDateOfBirthSchema }),
  asyncHandler(controller.setDateOfBirth),
);

onboardingRouter.post('/complete', asyncHandler(controller.completeOnboarding));
