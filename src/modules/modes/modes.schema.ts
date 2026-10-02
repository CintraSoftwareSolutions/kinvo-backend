import { z } from 'zod';

import { Mode } from '@/db/prisma';

export const modeParamSchema = z.object({
  mode: z.nativeEnum(Mode, {
    errorMap: () => ({ message: 'That is not one of the eight modes.' }),
  }),
});

export const updateModeSchema = z
  .object({
    is_enabled: z.boolean().optional(),
    min_age: z.number().int().min(18, 'Nobody under 18 is on Kinvo.').max(120).optional(),
    max_age: z.number().int().min(18).max(120).optional(),
    radius_metres: z
      .number()
      .int()
      .positive('A radius must be greater than zero.')
      .max(500000, 'That radius is too large.')
      .optional(),
    verified_only: z.boolean().optional(),
    preferences: z.record(z.unknown()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to update.',
  });

export type UpdateModeBody = z.infer<typeof updateModeSchema>;
