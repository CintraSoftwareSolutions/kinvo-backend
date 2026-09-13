import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as matchesService from './matches.service';
import type { ListMatchesQuery } from './matches.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function listMatches(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor, archived, mode } = req.query as unknown as ListMatchesQuery;

  const result = await matchesService.listMatches(user.id, { limit, cursor, archived, mode });

  sendList(res, result.matches, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function getMatch(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await matchesService.getMatch(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

export async function unmatch(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  await matchesService.unmatch(user.id, req.params.id as string);

  sendSuccess(res, { unmatched: true });
}

export async function extendMatch(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await matchesService.extendMatch(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}
