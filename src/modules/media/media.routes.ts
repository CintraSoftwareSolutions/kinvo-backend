import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './media.controller';
import {
  addPhotoSchema,
  attachDocumentSchema,
  createUploadSchema,
  photoIdParamSchema,
  reorderPhotosSchema,
  startVerificationSchema,
  uploadIdParamSchema,
  verificationIdParamSchema,
} from './media.schema';

/**
 * Media and verification routes (spec §7, Batch 4).
 *
 * Everything here is authenticated and scoped to the caller. There is
 * deliberately no route that takes another user's id — media belonging to
 * someone else is only ever reached through their profile, which applies the
 * shared block clause first.
 *
 * `requireOnboarded` is NOT mounted: uploading a photo is part of onboarding,
 * so gating it behind a completed onboarding would deadlock the flow.
 */
export const mediaRouter: Router = Router();

mediaRouter.use(authenticate);

// --- Uploads ---------------------------------------------------------------

mediaRouter.post(
  '/uploads',
  validate({ body: createUploadSchema }),
  asyncHandler(controller.createUpload),
);

mediaRouter.post(
  '/uploads/:id/complete',
  validate({ params: uploadIdParamSchema }),
  asyncHandler(controller.completeUpload),
);

mediaRouter.get(
  '/uploads/:id/url',
  validate({ params: uploadIdParamSchema }),
  asyncHandler(controller.getUploadUrl),
);

mediaRouter.delete(
  '/uploads/:id',
  validate({ params: uploadIdParamSchema }),
  asyncHandler(controller.deleteUpload),
);

// --- Profile photos --------------------------------------------------------

mediaRouter.get('/photos', asyncHandler(controller.listPhotos));

mediaRouter.post('/photos', validate({ body: addPhotoSchema }), asyncHandler(controller.addPhoto));

// Before /photos/:id, or "reorder" would be read as a photo id.
mediaRouter.patch(
  '/photos/reorder',
  validate({ body: reorderPhotosSchema }),
  asyncHandler(controller.reorderPhotos),
);

mediaRouter.patch(
  '/photos/:id/primary',
  validate({ params: photoIdParamSchema }),
  asyncHandler(controller.setPrimaryPhoto),
);

mediaRouter.delete(
  '/photos/:id',
  validate({ params: photoIdParamSchema }),
  asyncHandler(controller.deletePhoto),
);

// --- Verification ----------------------------------------------------------

export const verificationRouter: Router = Router();

verificationRouter.use(authenticate);

verificationRouter.get('/', asyncHandler(controller.getVerification));

verificationRouter.post(
  '/',
  validate({ body: startVerificationSchema }),
  asyncHandler(controller.startVerification),
);

verificationRouter.post(
  '/:id/document',
  validate({ params: verificationIdParamSchema, body: attachDocumentSchema }),
  asyncHandler(controller.attachVerificationDocument),
);

verificationRouter.post(
  '/:id/submit',
  validate({ params: verificationIdParamSchema }),
  asyncHandler(controller.submitVerification),
);
