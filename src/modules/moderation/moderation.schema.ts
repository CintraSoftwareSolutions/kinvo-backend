import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { ModerationSeverity, ReportStatus } from '@/db/prisma';

/** Moderation request validation (spec §4.10, Batch 10). */

/**
 * What is being checked. Kept as a closed list rather than a free string so a
 * typo cannot create a subject type the moderation queue silently never
 * displays.
 */
export const SUBJECT_TYPES = ['message', 'bio', 'prompt_answer', 'display_name', 'photo'] as const;

export const checkContentSchema = z
  .object({
    content: z.string().trim().min(1).max(4000),
    subject_type: z.enum(SUBJECT_TYPES).default('message'),
    /** Present when checking something already stored, absent for a draft. */
    subject_id: z.string().uuid().optional(),
    /**
     * spec §5.4: recorded when the user pushes past a warning. This is a
     * record of a decision, never permission to skip the check — the server
     * runs it either way.
     */
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
