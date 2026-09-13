import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
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
