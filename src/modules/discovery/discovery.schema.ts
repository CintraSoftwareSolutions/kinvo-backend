import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { Mode, SwipeAction } from '@/db/prisma';

/**
 * Discovery request validation (spec §4.10, Batch 7).
 *
 * The mode comes from the path on every route here, so mode scoping is a
 * required, validated part of every request rather than an optional body field
 * someone can forget to send.
 */

export const modeParamSchema = z
  .object({
    mode: z.nativeEnum(Mode, {
      errorMap: () => ({ message: 'Unknown mode.' }),
    }),
  })
  .strict();

export const paginationQuerySchema = z
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

export const swipeBodySchema = z
  .object({
    target_id: z.string().uuid('Expected a user id.'),
    /**
     * spec §1: the three actions are the same in every mode. Mode changes only
     * the label the app renders, served from GET /config. A per-mode action
     * enum would fork the client for no product reason.
     */
    action: z.nativeEnum(SwipeAction, {
      errorMap: () => ({ message: 'Expected pass, like, or super_like.' }),
    }),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type SwipeBody = z.infer<typeof swipeBodySchema>;
