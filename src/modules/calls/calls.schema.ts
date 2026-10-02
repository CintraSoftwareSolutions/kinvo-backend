import { z } from 'zod';

import { PAGINATION } from '@config/constants';

export const callIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const startCallSchema = z
  .object({
    match_id: z.string().uuid(),
    kind: z.enum(['video', 'audio']).optional().default('video'),
  })
  .strict();

export const listCallsQuerySchema = z
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

export const safetyActionSchema = z
  .object({
    action: z.enum(['flag', 'end_and_report', 'send_live_update']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type StartCallBody = z.infer<typeof startCallSchema>;
export type ListCallsQuery = z.infer<typeof listCallsQuerySchema>;
export type SafetyActionBody = z.infer<typeof safetyActionSchema>;
