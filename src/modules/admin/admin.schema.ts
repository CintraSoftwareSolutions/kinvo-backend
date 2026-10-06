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
