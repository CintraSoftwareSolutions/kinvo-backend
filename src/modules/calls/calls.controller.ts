import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { getVideoProvider } from '@/providers/video.provider';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { sendList, sendSuccess } from '@utils/response';
import * as callsService from './calls.service';
import type { ListCallsQuery, SafetyActionBody, StartCallBody } from './calls.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function startCall(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as StartCallBody;

  const call = await callsService.startCall(user.id, body.match_id, body.kind);

  sendSuccess(res, { call }, 201);
}

export async function answerCall(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const call = await callsService.answerCall(user.id, req.params.id!);

  sendSuccess(res, { call });
}

export async function declineCall(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const call = await callsService.declineCall(user.id, req.params.id!);

  sendSuccess(res, { call });
}

export async function endCall(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const call = await callsService.endCall(user.id, req.params.id!);

  sendSuccess(res, { call });
}

export async function issueToken(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const call = await callsService.issueCallToken(user.id, req.params.id!);

  sendSuccess(res, { call });
}

export async function listCalls(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor } = req.query as unknown as ListCallsQuery;

  const result = await callsService.listCalls(user.id, { limit, cursor });

  sendList(res, result.calls, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function recordSafetyAction(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as SafetyActionBody;

  const result = await callsService.recordSafetyAction(user.id, req.params.id!, {
    action: body.action,
    note: body.note,
  });

  sendSuccess(res, { ...result });
}

/**
 * The video provider's status callback (Batch 14 follow-up, LiveKit in 16).
 *
 * NOT authenticated by a bearer token — the provider has none. Its SIGNATURE is
 * the authentication: LiveKit sends an `Authorization` header holding a JWT
 * that carries a sha256 of the body, so the body is verified before a single
 * field of it is read.
 *
 * The raw bytes matter. `app.ts` gives this one path `express.raw`, because a
 * body that has been parsed and re-serialised no longer hashes to the value the
 * JWT claims.
 *
 * Response codes carry meaning to the provider:
 *
 *   403 — the signature did not verify. The provider surfaces the endpoint as
 *         misconfigured, which is right: a forged request must never be
 *         acknowledged as accepted.
 *   200 — accepted, or an event we deliberately ignore. Anything else makes the
 *         provider retry an event nothing will ever act on.
 */
export async function handleVideoWebhook(req: Request, res: Response): Promise<void> {
  // `express.raw` leaves a Buffer. Anything else means the carve-out in app.ts
  // has been moved or removed, and verifying a re-serialised body would refuse
  // every real callback — so this fails loudly rather than silently.
  const raw = req.body as unknown;
  const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : null;

  if (body === null) {
    logger.error('video webhook body was parsed before it could be verified');
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'Invalid signature.');
  }

  const event = await getVideoProvider().readWebhook({
    body,
    // LiveKit's own documentation has used both spellings over time. Reading
    // either costs nothing and saves an outage that would look like a signature
    // failure.
    authorization: req.get('authorization') ?? req.get('authorize'),
  });

  if (!event) {
    logger.warn({ path: req.path }, 'video webhook signature rejected');
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'Invalid signature.');
  }

  const result = await callsService.applyRoomEvent(event);

  sendSuccess(res, { received: true, applied: result.applied });
}
