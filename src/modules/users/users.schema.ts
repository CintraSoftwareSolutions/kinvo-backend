import { z } from 'zod';

import { MAX_INTERESTS, MAX_PROMPTS } from '@modules/profiles/profiles.service';

/**
 * Zod schemas for the profile and onboarding endpoints (spec §0.5).
 *
 * Optional-and-nullable throughout: PATCH semantics need three states — absent
 * means "leave it alone", null means "clear it", and a value means "set it".
 * Using only optional would make clearing a field impossible.
 */

const nullableString = (max: number, message: string) =>
  z.string().trim().max(max, message).nullable().optional();

const lifestyleFrequency = z
  .enum(['never', 'rarely', 'socially', 'regularly', 'prefer_not_to_say'])
  .nullable()
  .optional();

export const updateProfileSchema = z
  .object({
    display_name: z
      .string()
      .trim()
      .min(1, 'Enter your name.')
      .max(50, 'Names can be at most 50 characters.')
      .optional(),
    bio: nullableString(500, 'Bios can be at most 500 characters.'),
    job_title: nullableString(100, 'Job titles can be at most 100 characters.'),
    organisation: nullableString(100, 'Organisation names can be at most 100 characters.'),
    education: z
      .enum([
        'high_school',
        'undergraduate',
        'postgraduate',
        'doctorate',
        'other',
        'prefer_not_to_say',
      ])
      .nullable()
      .optional(),
    height_cm: z
      .number()
      .int()
      .min(120, 'Enter a height between 120cm and 250cm.')
      .max(250, 'Enter a height between 120cm and 250cm.')
      .nullable()
      .optional(),
    city: nullableString(120, 'City names can be at most 120 characters.'),
    country: z.string().trim().length(2, 'Use a two-letter country code.').nullable().optional(),
    drinking: lifestyleFrequency,
    smoking: lifestyleFrequency,
    exercise: z
      .enum(['never', 'sometimes', 'often', 'daily', 'prefer_not_to_say'])
      .nullable()
      .optional(),
    diet: z
      .enum([
        'omnivore',
        'vegetarian',
        'vegan',
        'pescatarian',
        'halal',
        'kosher',
        'other',
        'prefer_not_to_say',
      ])
      .nullable()
      .optional(),
    pets: z
      .enum(['none', 'dog', 'cat', 'other', 'multiple', 'prefer_not_to_say'])
      .nullable()
      .optional(),
    children: z
      .enum([
        'none',
        'have_children',
        'want_children',
        'do_not_want_children',
        'open',
        'prefer_not_to_say',
      ])
      .nullable()
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to update.',
  });

export const updateLocationSchema = z.object({
  // spec §4.6 and src/db/geo.ts: longitude then latitude, always.
  longitude: z
    .number({ required_error: 'Longitude is required.' })
    .min(-180, 'Longitude must be between -180 and 180.')
    .max(180, 'Longitude must be between -180 and 180.'),
  latitude: z
    .number({ required_error: 'Latitude is required.' })
    .min(-90, 'Latitude must be between -90 and 90.')
    .max(90, 'Latitude must be between -90 and 90.'),
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().length(2, 'Use a two-letter country code.').optional(),
});

export const setInterestsSchema = z.object({
  interests: z
    .array(z.string().trim().min(1))
    .max(MAX_INTERESTS, `Choose at most ${MAX_INTERESTS} interests.`),
});

export const setPromptsSchema = z.object({
  prompts: z
    .array(
      z.object({
        slug: z.string().trim().min(1, 'Choose a prompt.'),
        answer: z
          .string()
          .trim()
          .min(1, 'Write an answer.')
          .max(300, 'Answers can be at most 300 characters.'),
      }),
    )
    .max(MAX_PROMPTS, `Answer at most ${MAX_PROMPTS} prompts.`),
});

export const setDateOfBirthSchema = z.object({
  date_of_birth: z
    .string({ required_error: 'Enter your date of birth.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.'),
});

export const userIdParamSchema = z.object({
  id: z.string().uuid('That is not a valid user id.'),
});

export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;
export type UpdateLocationBody = z.infer<typeof updateLocationSchema>;
export type SetInterestsBody = z.infer<typeof setInterestsSchema>;
export type SetPromptsBody = z.infer<typeof setPromptsSchema>;
export type SetDateOfBirthBody = z.infer<typeof setDateOfBirthSchema>;
