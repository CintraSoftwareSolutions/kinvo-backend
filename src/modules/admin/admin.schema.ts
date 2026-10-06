import { z } from 'zod';

import { PAGINATION } from '@config/constants';

/** Admin request validation (spec §0.5, Batch 15). */

export const roleIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const createRoleSchema = z
  .object({
    /**
     * Machine key, lower snake/dotted. The panel shows `title`; code matches on
     * this, so it is constrained rather than free text — a key with a space in
     * it reads fine in a list and breaks every comparison.
     */
    key: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, digits and underscores.'),
    title: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    title: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to update.',
  });

/**
 * Setting the matrix for one role.
 *
 * Takes the WHOLE set of changes rather than one cell at a time. The panel
 * renders a matrix and saves it; a per-cell endpoint would turn one save into
 * fifteen requests, any of which could fail and leave the matrix half-applied
 * with nothing to say so.
 */
export const setPermissionsSchema = z
  .object({
    permissions: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(64),
            allowed: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const addRoleMemberSchema = z.object({ user_id: z.string().uuid() }).strict();

export const roleMemberParamsSchema = z
  .object({ id: z.string().uuid(), userId: z.string().uuid() })
  .strict();

export const guardrailKeyParamSchema = z.object({ key: z.string().trim().min(1).max(64) }).strict();

export const setGuardrailSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * The audit log is read with a filter, never dumped.
 *
 * `actor` and `target` narrow to one person or one thing, which is how the two
 * questions anybody actually asks of an audit log are phrased: "what did this
 * admin do" and "who touched this account".
 */
export const auditLogQuerySchema = z
  .object({
    actor_id: z.string().uuid().optional(),
    target_type: z.string().trim().min(1).max(32).optional(),
    target_id: z.string().uuid().optional(),
    action: z.string().trim().min(1).max(64).optional(),
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

export type CreateRoleBody = z.infer<typeof createRoleSchema>;
export type UpdateRoleBody = z.infer<typeof updateRoleSchema>;
export type SetPermissionsBody = z.infer<typeof setPermissionsSchema>;
export type AddRoleMemberBody = z.infer<typeof addRoleMemberSchema>;
export type SetGuardrailBody = z.infer<typeof setGuardrailSchema>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

// --- users -----------------------------------------------------------------

export const userIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const listUsersQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['pending', 'active', 'suspended', 'deleted']).optional(),
    tier: z.enum(['free', 'basic', 'advanced']).optional(),
    mode: z
      .enum([
        'dating',
        'study_buddy',
        'networking',
        'trading',
        'foodie',
        'cuddle',
        'pet_dates',
        'fitness',
      ])
      .optional(),
    flagged: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    staff: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
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

/**
 * A reason is REQUIRED to suspend.
 *
 * The account holder is told why, and an operator reviewing the decision later
 * needs to know what it was for. A suspension with no reason cannot be
 * explained or safely reversed by anybody but the person who made it.
 */
export const suspendUserSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export const setStaffRoleSchema = z
  .object({ role: z.enum(['user', 'moderator', 'admin']) })
  .strict();

export const activityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type SuspendUserBody = z.infer<typeof suspendUserSchema>;
export type SetStaffRoleBody = z.infer<typeof setStaffRoleSchema>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

// --- moderation queue ------------------------------------------------------

export const moderationQueueQuerySchema = z
  .object({
    status: z.enum(['open', 'under_review', 'actioned', 'dismissed']).optional(),
    severity: z.enum(['High', 'Medium', 'Low']).optional(),
    assigned_to_id: z.string().uuid().optional(),
    unassigned: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
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

export const flagIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * `null` clears the assignment, so the key is nullable rather than optional.
 *
 * Absent and explicitly-null mean different things here — "leave it alone" is
 * not a request this endpoint accepts, since its only job is to set the field.
 */
export const assignFlagSchema = z
  .object({ assignee_id: z.string().uuid().nullable() })
  .strict();

// --- venues ----------------------------------------------------------------

/** Mirrors the `VenueCategory` enum exactly — a value outside it is a 500. */
const VENUE_CATEGORIES = [
  'cafe',
  'restaurant',
  'park',
  'gym',
  'study_spot',
  'pet_friendly',
  'romantic',
  'health_conscious',
] as const;

export const listVenuesQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    category: z.enum(VENUE_CATEGORIES).optional(),
    featured: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    reviewed: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    active: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
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

export const venueIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * Location is NOT editable here.
 *
 * A venue's coordinates live in a PostGIS `geography` column that Prisma cannot
 * write (CLAUDE.md), so every spatial write goes through `src/db/geo.ts`. An
 * admin edit that silently dropped a moved venue's new coordinates would be
 * worse than refusing to move it at all, so this endpoint handles the editorial
 * fields and nothing spatial.
 */
export const updateVenueSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    category: z.enum(VENUE_CATEGORIES).optional(),
    is_featured: z.boolean().optional(),
    is_reviewed: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
  });

// --- plans -----------------------------------------------------------------

export const productIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * `tier` and `billing_cycle` are absent on purpose — see `plans.service.ts`.
 * Changing a product's tier would change what its existing subscribers are
 * entitled to without a payment, which spec §5.10 forbids outright.
 */
export const updateProductSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    rollout_state: z.enum(['live', 'promo', 'draft', 'grandfathered']).optional(),
    rollout_note: z.string().trim().max(300).nullable().optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
  });

/**
 * spec §4.6: money is integer minor units plus a currency code. A float price
 * would be rejected here, which is the point of `.int()` on an amount.
 *
 * Zero is allowed — a free promotional plan is a real thing the catalogue needs
 * to express — but a negative amount never is.
 */
export const setProductPriceSchema = z
  .object({
    amount_minor: z.number().int().min(0).max(100_000_000),
    currency: z
      .string()
      .trim()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'Use a three-letter upper-case ISO 4217 code.'),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type ModerationQueueQuery = z.infer<typeof moderationQueueQuerySchema>;
export type AssignFlagBody = z.infer<typeof assignFlagSchema>;
export type ListVenuesQuery = z.infer<typeof listVenuesQuerySchema>;
export type UpdateVenueBody = z.infer<typeof updateVenueSchema>;
export type UpdateProductBody = z.infer<typeof updateProductSchema>;
export type SetProductPriceBody = z.infer<typeof setProductPriceSchema>;

/**
 * Creating a venue.
 *
 * COORDINATES ARE REQUIRED. Every suggestion query is a radius query, so a
 * venue with no location would never be shown to anybody while looking complete
 * in the panel's list — invisible-but-present is the worst of both.
 *
 * `is_featured` is absent on purpose: featuring is a separate decision with its
 * own audit entry, and bundling it into creation would let a venue reach every
 * user in the same request that first described it. `modes` has a minimum of
 * one, because a venue matching no mode can never be suggested either.
 */
export const createVenueSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    category: z.enum(VENUE_CATEGORIES),
    description: z.string().trim().max(1000).optional(),
    address: z.string().trim().max(300).optional(),
    city: z.string().trim().max(120).optional(),
    /** ISO 3166-1 alpha-2, matching the CHAR(2) column. */
    country: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Z]{2}$/, 'Use a two-letter upper-case ISO country code.')
      .optional(),
    modes: z
      .array(
        z.enum([
          'dating',
          'study_buddy',
          'networking',
          'trading',
          'foodie',
          'cuddle',
          'pet_dates',
          'fitness',
        ]),
      )
      .min(1)
      .max(8),
    /** The usual 1..4 price scale. */
    price_level: z.number().int().min(1).max(4).optional(),
    /** spec: (longitude, latitude) — ST_MakePoint takes X then Y. */
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
  })
  .strict();

export type CreateVenueBody = z.infer<typeof createVenueSchema>;
