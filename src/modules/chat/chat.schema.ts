import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { MessageType, Mode } from '@/db/prisma';

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

export const sendMessageSchema = z
  .object({
    type: z.nativeEnum(MessageType).default(MessageType.text),
    body: z.string().trim().min(1).max(2000).optional(),
    media_asset_id: z.string().uuid().optional(),
    venue_id: z.string().uuid().optional(),
    duration_ms: z.number().int().positive().max(600_000).optional(),
    moderation_overridden: z.boolean().optional(),
    client_token: z.string().uuid('A client token must be a uuid.').optional(),
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
