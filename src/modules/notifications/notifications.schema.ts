import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { NotificationCategory } from '@/db/prisma';

/** Notification request validation (spec §4.10, Batch 11). */

export const listQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION.MAX_LIMIT)
      .optional()
      .default(PAGINATION.DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
    unread_only: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

export const notificationIdParamSchema = z
  .object({ id: z.string().uuid('Expected a notification id.') })
  .strict();

export const categoryParamSchema = z
  .object({ category: z.nativeEnum(NotificationCategory) })
  .strict();

export const updatePreferenceSchema = z
  .object({
    push_enabled: z.boolean().optional(),
    email_enabled: z.boolean().optional(),
    in_app_enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

/**
 * spec §7: FCM token registration. The token is bound to a device rather than a
 * user, because one person may have several and each has its own token.
 */
export const registerPushTokenSchema = z
  .object({
    device_id: z.string().min(1).max(128),
    fcm_token: z.string().min(1).max(4096),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;
export type UpdatePreferenceBody = z.infer<typeof updatePreferenceSchema>;
export type RegisterPushTokenBody = z.infer<typeof registerPushTokenSchema>;
