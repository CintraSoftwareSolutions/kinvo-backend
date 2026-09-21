import { z } from 'zod';

import { PAGINATION } from '@config/constants';

/** Call request validation (spec §5.7, §7, Batch 14). */

export const callIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * Starting a call names a MATCH, never a user and never a room.
 *
 * A user id would have to be checked back to a match anyway, and a room name
 * from the client is the exact hole the spec warns about — it would let someone
 * ask for a token to a room they were never invited to. The room is derived
 * server-side from the call id.
 */
export const startCallSchema = z
  .object({
    match_id: z.string().uuid(),
    /**
     * Video unless the caller says otherwise, so a client that predates voice
     * calls keeps behaving exactly as it did.
     *
     * The kind is stored rather than kept on the caller's phone because the
     * person being rung needs it before they answer: answering a voice call
     * must not open their camera.
     */
    kind: z.enum(['video', 'audio']).optional().default('video'),
  })
  .strict();

export const listCallsQuerySchema = z
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

/**
 * In-call safety actions (spec §5.7).
 *
 * `note` is optional on purpose. Someone reaching for a safety control mid-call
 * is not in a position to write an explanation, and requiring one would mean
 * the action fails at the moment it is most needed.
 */
export const safetyActionSchema = z
  .object({
    action: z.enum(['flag', 'end_and_report', 'send_live_update']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type StartCallBody = z.infer<typeof startCallSchema>;
export type ListCallsQuery = z.infer<typeof listCallsQuerySchema>;
export type SafetyActionBody = z.infer<typeof safetyActionSchema>;
