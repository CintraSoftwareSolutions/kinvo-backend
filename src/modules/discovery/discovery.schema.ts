import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { Mode, SwipeAction } from '@/db/prisma';

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
    action: z.nativeEnum(SwipeAction, {
      errorMap: () => ({ message: 'Expected pass, like, or super_like.' }),
    }),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type SwipeBody = z.infer<typeof swipeBodySchema>;
