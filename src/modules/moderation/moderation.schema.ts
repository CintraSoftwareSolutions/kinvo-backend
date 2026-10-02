import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { ModerationSeverity, ReportStatus } from '@/db/prisma';

export const SUBJECT_TYPES = ['message', 'bio', 'prompt_answer', 'display_name', 'photo'] as const;

export const checkContentSchema = z
  .object({
    content: z.string().trim().min(1).max(4000),
    subject_type: z.enum(SUBJECT_TYPES).default('message'),
    subject_id: z.string().uuid().optional(),
    overridden: z.boolean().optional(),
  })
  .strict();

export const listFlagsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION.MAX_LIMIT)
      .optional()
      .default(PAGINATION.DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
    status: z.nativeEnum(ReportStatus).optional(),
    severity: z.nativeEnum(ModerationSeverity).optional(),
  })
  .strict();

export const flagIdParamSchema = z.object({ id: z.string().uuid('Expected a flag id.') }).strict();

export const resolveFlagSchema = z
  .object({
    status: z.enum([ReportStatus.under_review, ReportStatus.actioned, ReportStatus.dismissed]),
  })
  .strict();

export type CheckContentBody = z.infer<typeof checkContentSchema>;
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;
export type ResolveFlagBody = z.infer<typeof resolveFlagSchema>;
