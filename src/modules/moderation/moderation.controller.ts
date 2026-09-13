import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as moderationService from './moderation.service';
import type { CheckContentBody, ListFlagsQuery, ResolveFlagBody } from './moderation.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function checkContent(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as CheckContentBody;

  const result = await moderationService.check({
    userId: user.id,
    content: body.content,
    subjectType: body.subject_type,
    subjectId: body.subject_id ?? null,
    overridden: body.overridden,
  });

  sendSuccess(res, { ...result });
}

export async function listFlags(req: Request, res: Response): Promise<void> {
  const { limit, cursor, status, severity } = req.query as unknown as ListFlagsQuery;

  const result = await moderationService.listFlags({ limit, cursor, status, severity });

  sendList(res, result.flags, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function resolveFlag(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as ResolveFlagBody;

  const result = await moderationService.resolveFlag(user.id, req.params.id as string, body.status);

  sendSuccess(res, { ...result });
}
