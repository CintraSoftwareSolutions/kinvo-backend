import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requireOnboarded } from '@middleware/require-onboarded';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './venues.controller';
import { matchIdParamSchema, searchVenuesQuerySchema, venueIdParamSchema } from './venues.schema';

/**
 * Venue routes (spec §7, §5.9, Batch 12).
 *
 * Read-only for users. Venues are admin-curated because the list is where the
 * product suggests two strangers meet; creating and editing them belongs to the
 * admin module in Batch 15.
 */
export const venuesRouter: Router = Router();

venuesRouter.use(authenticate, requireOnboarded);

venuesRouter.get(
  '/',
  validate({ query: searchVenuesQuerySchema }),
  asyncHandler(controller.searchVenues),
);

/** Literal paths first, so neither is parsed as a venue id. */
venuesRouter.get('/saved', asyncHandler(controller.listSaved));

venuesRouter.get(
  '/suggest/:match_id',
  validate({ params: matchIdParamSchema }),
  asyncHandler(controller.suggestForMatch),
);

venuesRouter.get(
  '/:id',
  validate({ params: venueIdParamSchema }),
  asyncHandler(controller.getVenue),
);

venuesRouter.post(
  '/:id/save',
  validate({ params: venueIdParamSchema }),
  asyncHandler(controller.saveVenue),
);

venuesRouter.delete(
  '/:id/save',
  validate({ params: venueIdParamSchema }),
  asyncHandler(controller.unsaveVenue),
);
