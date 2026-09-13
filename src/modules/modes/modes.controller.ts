import type { Request, Response } from 'express';

import type { Mode } from '@/db/prisma';
import { requireUser } from '@middleware/authenticate';
import { sendSuccess } from '@utils/response';
import type { UpdateModeBody } from './modes.schema';
import * as modesService from './modes.service';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function listModes(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await modesService.listModes(user.id);
  sendSuccess(res, { ...result });
}

export async function getMode(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;

  const result = await modesService.getMode(user.id, mode);
  sendSuccess(res, { ...result });
}

export async function updateMode(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;
  const body = req.body as UpdateModeBody;

  const result = await modesService.updateMode(user.id, mode, body);
  sendSuccess(res, { ...result });
}

export async function setPrimaryMode(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const mode = req.params.mode as Mode;

  const result = await modesService.setPrimaryMode(user.id, mode);
  sendSuccess(res, { ...result });
}
