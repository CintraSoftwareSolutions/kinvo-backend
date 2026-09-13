import type { Request, Response } from 'express';

import type { Mode } from '@/db/prisma';
import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as boostService from './boost.service';
import * as deckService from './deck.service';
import * as swipeService from './swipe.service';
import type { PaginationQuery, SwipeBody } from './discovery.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function getDeck(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;
  const { limit, cursor } = req.query as unknown as PaginationQuery;

  const result = await deckService.getDeck(user.id, mode, { limit, cursor });

  sendList(res, result.cards, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function swipe(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;
  const body = req.body as SwipeBody;

  const result = await swipeService.swipe(user.id, mode, body.target_id, body.action);

  sendSuccess(res, { ...result }, 201);
}

export async function rewind(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;

  const result = await swipeService.rewind(user.id, mode);

  sendSuccess(res, { ...result });
}

export async function likesYou(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;
  const { limit, cursor } = req.query as unknown as PaginationQuery;

  const result = await swipeService.likesYou(user.id, mode, { limit, cursor });

  sendList(res, result.likes, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function startBoost(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;

  const result = await boostService.startBoost(user.id, mode);

  sendSuccess(res, { ...result }, 201);
}

export async function stats(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;

  const result = await boostService.deckStats(user.id, mode);

  sendSuccess(res, { ...result });
}
