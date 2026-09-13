import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { EmergencyEventType, ReportReason, ReportStatus } from '@/db/prisma';

/** Safety request validation (spec §4.10, §5.7, Batch 12). */

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
  })
  .strict();

export const createReportSchema = z
  .object({
    reported_id: z.string().uuid('Expected a user id.'),
    reason: z.nativeEnum(ReportReason),
    description: z.string().trim().max(1000).optional(),
    /** What was being looked at when they reported: profile, message, call, plan. */
    context_type: z.enum(['profile', 'message', 'call', 'plan']).optional(),
    context_id: z.string().uuid().optional(),
    /** spec §5.7: blocks atomically on submit. */
    also_block: z.boolean().optional(),
    /** Completed uploads of kind report_evidence. */
    evidence_asset_ids: z.array(z.string().uuid()).max(5).optional(),
  })
  .strict();

export const reviewReportsQuerySchema = listQuerySchema.extend({
  status: z.nativeEnum(ReportStatus).optional(),
  reason: z.nativeEnum(ReportReason).optional(),
});

export const resolveReportSchema = z
  .object({
    status: z.enum([ReportStatus.under_review, ReportStatus.actioned, ReportStatus.dismissed]),
    resolution_note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const userIdParamSchema = z
  .object({ user_id: z.string().uuid('Expected a user id.') })
  .strict();

export const idParamSchema = z.object({ id: z.string().uuid() }).strict();

export const blockSchema = z.object({ user_id: z.string().uuid('Expected a user id.') }).strict();

export const createContactSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(5).max(32).optional(),
    email: z.string().trim().email().max(320).optional(),
    relationship: z.string().trim().max(64).optional(),
  })
  .strict();

export const updateContactSchema = createContactSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

const coordinate = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

export const startSharingSchema = z
  .object({
    plan_id: z.string().uuid().optional(),
    duration_minutes: z.number().int().min(5).max(480).optional(),
  })
  .strict();

export const pingSchema = coordinate
  .extend({ accuracy_metres: z.number().int().min(0).max(10_000).optional() })
  .strict();

export const emergencySchema = z
  .object({
    type: z.nativeEnum(EmergencyEventType).optional(),
    note: z.string().trim().max(500).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: 'Give both latitude and longitude, or neither.',
    path: ['latitude'],
  });

export type ListQuery = z.infer<typeof listQuerySchema>;
export type CreateReportBody = z.infer<typeof createReportSchema>;
export type ReviewReportsQuery = z.infer<typeof reviewReportsQuerySchema>;
export type ResolveReportBody = z.infer<typeof resolveReportSchema>;
export type CreateContactBody = z.infer<typeof createContactSchema>;
export type UpdateContactBody = z.infer<typeof updateContactSchema>;
export type StartSharingBody = z.infer<typeof startSharingSchema>;
export type PingBody = z.infer<typeof pingSchema>;
export type EmergencyBody = z.infer<typeof emergencySchema>;
