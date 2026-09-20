import { z } from 'zod';

import { PAGINATION } from '@config/constants';

import { MAX_PHOTOS } from './photos.service';

/** Zod schemas for the media and verification endpoints (spec §0.5). */

export const createUploadSchema = z.object({
  purpose: z.enum(
    [
      'profile_photo',
      'chat_image',
      'chat_video',
      'voice_note',
      'verification_document',
      'report_evidence',
    ],
    { required_error: 'Say what this upload is for.' },
  ),
  mime_type: z
    .string({ required_error: 'A file type is required.' })
    .trim()
    .min(1, 'A file type is required.')
    .max(128),
  size_bytes: z
    .number({ required_error: 'A file size is required.' })
    .int('A file size must be a whole number of bytes.')
    .positive('A file size must be greater than zero.'),
  /** Required for voice notes (spec §5.4); ignored elsewhere. */
  duration_ms: z.number().int().positive().optional(),
});

export const uploadIdParamSchema = z.object({
  id: z.string().uuid('That is not a valid upload id.'),
});

export const photoIdParamSchema = z.object({
  id: z.string().uuid('That is not a valid photo id.'),
});

export const addPhotoSchema = z.object({
  upload_id: z
    .string({ required_error: 'An upload id is required.' })
    .uuid('That is not a valid upload id.'),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const reorderPhotosSchema = z.object({
  photo_ids: z
    .array(z.string().uuid('That is not a valid photo id.'))
    .min(1, 'List the photos in the order you want.')
    .max(MAX_PHOTOS, `You can have at most ${MAX_PHOTOS} photos.`),
});

export const startVerificationSchema = z.object({
  method: z.enum(['photo', 'government_id', 'social'], {
    required_error: 'Choose a verification method.',
  }),
});

export const verificationIdParamSchema = z.object({
  id: z.string().uuid('That is not a valid verification id.'),
});

export const attachDocumentSchema = z.object({
  upload_id: z
    .string({ required_error: 'An upload id is required.' })
    .uuid('That is not a valid upload id.'),
});

export type CreateUploadBody = z.infer<typeof createUploadSchema>;
export type AddPhotoBody = z.infer<typeof addPhotoSchema>;
export type ReorderPhotosBody = z.infer<typeof reorderPhotosSchema>;
export type StartVerificationBody = z.infer<typeof startVerificationSchema>;
export type AttachDocumentBody = z.infer<typeof attachDocumentSchema>;

/**
 * Review queue filter (Batch 15 — verification review).
 *
 * Defaults to `pending`, because a queue is for work outstanding. The other
 * statuses are readable so the panel can show what was decided and by whom.
 */
export const reviewQueueQuerySchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION.MAX_LIMIT)
      .optional()
      .default(PAGINATION.DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * A decision.
 *
 * `reason` is required when declining and forbidden when approving — a
 * rejection with no reason leaves the user with nothing to fix, and an approval
 * carrying one would be stored against a record that was accepted.
 */
export const reviewDecisionSchema = z
  .object({
    approve: z.boolean(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((body) => body.approve || Boolean(body.reason), {
    message: 'Give a reason when declining a verification.',
    path: ['reason'],
  })
  .refine((body) => !body.approve || body.reason === undefined, {
    message: 'An approved verification takes no reason.',
    path: ['reason'],
  });

export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;
export type ReviewDecisionBody = z.infer<typeof reviewDecisionSchema>;
