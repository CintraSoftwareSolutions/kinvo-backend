import { z } from 'zod';

import { Mode, VenueCategory } from '@/db/prisma';

/** Venue request validation (spec §4.10, §5.9, Batch 12). */

export const searchVenuesQuerySchema = z
  .object({
    category: z.nativeEnum(VenueCategory).optional(),
    mode: z.nativeEnum(Mode).optional(),
    radius_metres: z.coerce.number().int().min(100).max(50_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    /** Browse another area without moving your profile location. */
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: 'Give both latitude and longitude, or neither.',
    path: ['latitude'],
  });

export const venueIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const matchIdParamSchema = z.object({ match_id: z.string().uuid() }).strict();

export type SearchVenuesQuery = z.infer<typeof searchVenuesQuerySchema>;
