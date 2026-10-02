import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { Mode } from '@/db/prisma';

export const matchIdParamSchema = z
  .object({ id: z.string().uuid('Expected a match id.') })
  .strict();

export const listMatchesQuerySchema = z
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

export type ListMatchesQuery = z.infer<typeof listMatchesQuerySchema>;
