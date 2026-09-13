import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendSuccess } from '@utils/response';
import * as subscriptionsService from './subscriptions.service';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function listProducts(_req: Request, res: Response): Promise<void> {
  const products = await subscriptionsService.listProducts();

  sendSuccess(res, { products });
}

export async function getMySubscription(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await subscriptionsService.getMySubscription(user.id);

  sendSuccess(res, { ...result });
}
