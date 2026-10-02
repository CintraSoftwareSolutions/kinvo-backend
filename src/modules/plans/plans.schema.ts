import { z } from 'zod';

import { PAGINATION } from '@config/constants';
import { utcOffsetMinutes } from '@modules/safety/safety.schema';

export const listPlansQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION.MAX_LIMIT)
      .optional()
      .default(PAGINATION.DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
    tab: z.enum(['upcoming', 'pending', 'history']).optional(),
    drafts: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

export const planIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const createPlanSchema = z
  .object({
    match_id: z.string().uuid('Expected a match id.'),
    venue_id: z.string().uuid().optional(),
    custom_location: z.string().trim().min(1).max(200).optional(),
    custom_address: z.string().trim().max(300).optional(),
    scheduled_at: z.string().datetime({ message: 'Expected an ISO-8601 timestamp.' }).optional(),
    duration_minutes: z.number().int().min(15).max(1440).optional(),
    notes: z.string().trim().max(1000).optional(),
    propose: z.boolean().optional(),
  })
  .strict();

export const updatePlanSchema = createPlanSchema
  .omit({ match_id: true, propose: true })
  .extend({
    venue_id: z.string().uuid().nullable(),
    custom_location: z.string().trim().min(1).max(200).nullable(),
    custom_address: z.string().trim().max(300).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const respondSchema = z.object({ accept: z.boolean() }).strict();

export const cancelSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

export const sharePlanSchema = z
  .object({
    contact_ids: z.array(z.string().uuid()).min(1).max(5),
    utc_offset_minutes: utcOffsetMinutes.optional(),
  })
  .strict();

export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;
export type CreatePlanBody = z.infer<typeof createPlanSchema>;
export type UpdatePlanBody = z.infer<typeof updatePlanSchema>;
export type RespondBody = z.infer<typeof respondSchema>;
export type CancelBody = z.infer<typeof cancelSchema>;
export type SharePlanBody = z.infer<typeof sharePlanSchema>;
