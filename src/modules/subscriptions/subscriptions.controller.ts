import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendSuccess } from '@utils/response';
import type { TestPurchaseBody } from './subscriptions.schema';
import * as subscriptionsService from './subscriptions.service';
import * as testPurchases from './test-purchases.service';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function listProducts(_req: Request, res: Response): Promise<void> {
  const products = await subscriptionsService.listProducts();

  // Beside the catalogue rather than in /config: the paywall asks what is on
  // sale and whether it can be bought here in one request.
  sendSuccess(res, { products, purchase_mode: testPurchases.purchaseMode() });
}

export async function getMySubscription(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await subscriptionsService.getMySubscription(user.id);

  sendSuccess(res, { ...result });
}

export async function purchaseForTesting(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { product } = req.body as TestPurchaseBody;

  const result = await testPurchases.purchaseForTesting(user.id, product);

  sendSuccess(res, { ...result }, 201);
}

export async function cancelTestPlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await testPurchases.cancelTestPlan(user.id);

  sendSuccess(res, { ...result });
}
