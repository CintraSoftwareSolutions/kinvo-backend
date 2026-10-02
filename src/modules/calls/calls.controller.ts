import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { getVideoProvider } from '@/providers/video.provider';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { sendList, sendSuccess } from '@utils/response';
import * as callsService from './calls.service';
import type { ListCallsQuery, SafetyActionBody, StartCallBody } from './calls.schema';

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

export async function handleVideoWebhook(req: Request, res: Response): Promise<void> {
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
