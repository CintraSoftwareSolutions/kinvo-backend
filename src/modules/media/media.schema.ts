import { z } from 'zod';

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
