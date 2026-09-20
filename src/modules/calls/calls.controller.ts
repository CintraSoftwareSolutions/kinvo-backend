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

  const call = await callsService.startCall(user.id, body.match_id);

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
 * The video provider's status callback (Batch 14 follow-up).
 *
 * NOT authenticated by a bearer token — the provider has none. Its SIGNATURE is
 * the authentication, verified over the request URL and the POST parameters
 * before a single field is read.
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
  const signature = req.get('x-twilio-signature');

  if (!signature) {
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'Missing signature.');
  }

  // The signature covers the URL the provider was configured with, so it has to
  // be reconstructed exactly — including the proxy's protocol and host, not the
  // container's. `trust proxy` is what makes req.protocol and req.get('host')
  // report what the caller actually addressed.
  const url = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  const params = req.body as Record<string, string>;

  if (!getVideoProvider().verifyWebhook({ signature, url, params })) {
    logger.warn({ path: req.path }, 'video webhook signature rejected');
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'Invalid signature.');
  }

  const result = await callsService.applyRoomEvent({
    type: params.StatusCallbackEvent ?? '',
    roomName: params.RoomName ?? '',
  });

  sendSuccess(res, { received: true, applied: result.applied });
}
