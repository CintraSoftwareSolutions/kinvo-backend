import { z } from 'zod';

import { Mode } from '@/db/prisma';

/**
 * Mode-specific preferences (spec §5.2).
 *
 * Common preferences — age range, radius, verified-only — are columns on
 * UserMode. The extras differ per mode and are stored as validated JSON:
 * "study_buddy has subject and academic level; dating has relationship goal;
 * pet_dates has pet type; trading has instrument interests."
 *
 * One schema per mode, dispatched on the mode. Sending `pet_type` to `dating`
 * is a validation error rather than a field silently stored and never read —
 * the JSON column would otherwise accept anything and the mistake would only
 * surface as a filter that quietly matches nobody.
 */

const empty = z.object({}).strict();

const dating = z
  .object({
    relationship_goal: z
      .enum(['long_term', 'short_term', 'friendship', 'figuring_it_out', 'prefer_not_to_say'])
      .optional(),
  })
  .strict();

const studyBuddy = z
  .object({
    subject: z.string().trim().min(1).max(80).optional(),
    academic_level: z
      .enum(['secondary', 'undergraduate', 'postgraduate', 'doctorate', 'professional', 'other'])
      .optional(),
    /** Where they want to study, not a scheduling system — that is Plans. */
    study_style: z.enum(['library', 'cafe', 'online', 'either']).optional(),
  })
  .strict();

const networking = z
  .object({
    industry: z.string().trim().min(1).max(80).optional(),
    seeking: z.enum(['mentorship', 'co_founder', 'hiring', 'job', 'peers', 'investors']).optional(),
    experience_level: z.enum(['student', 'junior', 'mid', 'senior', 'founder']).optional(),
  })
  .strict();

/**
 * spec §1: Trading is an interest category and nothing more. These are tags
 * describing what someone likes talking about. Nothing in this system quotes a
 * price, records a trade, moves an asset, or touches a brokerage.
 */
const trading = z
  .object({
    instruments: z
      .array(z.enum(['equities', 'crypto', 'forex', 'commodities', 'options', 'index_funds']))
      .max(6)
      .optional(),
    experience_level: z.enum(['curious', 'hobbyist', 'experienced', 'professional']).optional(),
  })
  .strict();

const foodie = z
  .object({
    cuisines: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    dining_style: z.enum(['street_food', 'casual', 'fine_dining', 'home_cooking']).optional(),
  })
  .strict();

const cuddle = z
  .object({
    comfort_level: z.enum(['platonic_only', 'open_to_more']).optional(),
    setting: z.enum(['public_only', 'either']).optional(),
  })
  .strict();

const petDates = z
  .object({
    pet_type: z.enum(['dog', 'cat', 'rabbit', 'bird', 'reptile', 'other', 'none_yet']).optional(),
    pet_name: z.string().trim().min(1).max(40).optional(),
    pet_size: z.enum(['small', 'medium', 'large']).optional(),
  })
  .strict();

const fitness = z
  .object({
    activities: z
      .array(
        z.enum([
          'running',
          'weightlifting',
          'yoga',
          'cycling',
          'climbing',
          'swimming',
          'team_sports',
          'martial_arts',
        ]),
      )
      .max(8)
      .optional(),
    intensity: z.enum(['gentle', 'moderate', 'intense']).optional(),
    time_of_day: z.enum(['morning', 'afternoon', 'evening', 'flexible']).optional(),
  })
  .strict();

/**
 * The per-mode schemas, keyed by mode.
 *
 * `.strict()` throughout, deliberately: an unknown key is rejected rather than
 * dropped, so a client sending the wrong shape learns immediately instead of
 * wondering why its filter has no effect.
 */
export const MODE_PREFERENCE_SCHEMAS: Record<Mode, z.ZodTypeAny> = {
  [Mode.dating]: dating,
  [Mode.study_buddy]: studyBuddy,
  [Mode.networking]: networking,
  [Mode.trading]: trading,
  [Mode.foodie]: foodie,
  [Mode.cuddle]: cuddle,
  [Mode.pet_dates]: petDates,
  [Mode.fitness]: fitness,
};

/** Modes with no extras in v1 still validate — they just accept nothing. */
export const MODES_WITHOUT_EXTRAS: Mode[] = [];

export function preferenceSchemaFor(mode: Mode): z.ZodTypeAny {
  return MODE_PREFERENCE_SCHEMAS[mode] ?? empty;
}
