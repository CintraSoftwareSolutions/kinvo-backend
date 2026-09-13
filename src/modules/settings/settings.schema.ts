import { z } from 'zod';

/** Validation for the settings and device endpoints (spec §0.5). */

export const updateSettingsSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    /**
     * Accessibility multiplier, not an arbitrary number. Below 0.8 the UI is
     * unreadable; above 2.0 it stops laying out. A CHECK constraint enforces
     * the same range at the database.
     */
    text_scale: z
      .number()
      .min(0.8, 'Text scale must be between 0.8 and 2.0.')
      .max(2.0, 'Text scale must be between 0.8 and 2.0.')
      .optional(),
    reduce_motion: z.boolean().optional(),
    high_contrast: z.boolean().optional(),
    /** Display only — the API is always metres (spec §4.6). */
    distance_unit: z.enum(['miles', 'kilometres']).optional(),
    show_distance: z.boolean().optional(),
    show_last_active: z.boolean().optional(),
    incognito: z.boolean().optional(),
    global_verified_only: z.boolean().optional(),
    pause_new_matches: z.boolean().optional(),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/, 'Use a language tag such as "en" or "en-GB".')
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to update.',
  });

export const snoozeSchema = z.object({
  /**
   * Optional. Omit to snooze until manually resumed; supply a time and a
   * scheduled job lifts it automatically.
   */
  ends_at: z
    .string()
    .datetime({ message: 'Use an ISO-8601 timestamp, e.g. 2026-09-01T00:00:00Z.' })
    .optional(),
});

export const deviceIdParamSchema = z.object({
  id: z.string().uuid('That is not a valid device id.'),
});

export type UpdateSettingsBody = z.infer<typeof updateSettingsSchema>;
export type SnoozeBody = z.infer<typeof snoozeSchema>;
