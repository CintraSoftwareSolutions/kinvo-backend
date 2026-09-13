import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { MessageType, Mode } from '@/db/prisma';

/** Chat request validation (spec §4.10, Batch 8). */

export const conversationIdParamSchema = z
  .object({ id: z.string().uuid('Expected a conversation id.') })
  .strict();

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
    archived: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    mode: z.nativeEnum(Mode).optional(),
  })
  .strict();

export const messagesQuerySchema = z
  .object({
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
 * spec §5.4: text, image, video, voice_note, venue_card. Voice notes carry
 * duration.
 *
 * The cross-field rules — a text message needs a body, a media message needs an
 * upload — are enforced in the service rather than here, because the media
 * check has to hit the database anyway (ownership, completion, kind) and
 * splitting the rule across two layers is how the halves drift apart.
 */
export const sendMessageSchema = z
  .object({
    type: z.nativeEnum(MessageType).default(MessageType.text),
    body: z.string().trim().min(1).max(2000).optional(),
    media_asset_id: z.string().uuid().optional(),
    venue_id: z.string().uuid().optional(),
    duration_ms: z.number().int().positive().max(600_000).optional(),
    /**
     * spec §5.4: set by the client after the user pushes past a pre-send
     * warning. Never a way to skip the check — Batch 10 runs moderation
     * server-side regardless of what arrives here.
     */
    moderation_overridden: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.type !== MessageType.text || (value.body?.length ?? 0) > 0, {
    message: 'A text message needs a body.',
    path: ['body'],
  });

export const updateConversationSchema = z
  .object({
    is_archived: z.boolean().optional(),
    is_muted: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type ListQuery = z.infer<typeof listQuerySchema>;
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type UpdateConversationBody = z.infer<typeof updateConversationSchema>;
