import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as plansService from './plans.service';
import type {
  CancelBody,
  CreatePlanBody,
  ListPlansQuery,
  RespondBody,
  SharePlanBody,
  UpdatePlanBody,
} from './plans.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function listPlans(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor, tab, drafts } = req.query as unknown as ListPlansQuery;

  const result = await plansService.listPlans(user.id, { limit, cursor, tab, drafts });

  sendList(res, result.plans, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function getPlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await plansService.getPlan(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

export async function createPlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await plansService.createPlan(user.id, req.body as CreatePlanBody);

  sendSuccess(res, { ...result }, 201);
}

export async function updatePlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await plansService.updatePlan(
    user.id,
    req.params.id as string,
    req.body as UpdatePlanBody,
  );

  sendSuccess(res, { ...result });
}

export async function proposePlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await plansService.proposePlan(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

export async function respondToPlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as RespondBody;

  const result = await plansService.respondToPlan(user.id, req.params.id as string, body.accept);

  sendSuccess(res, { ...result });
}

export async function cancelPlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as CancelBody;

  const result = await plansService.cancelPlan(user.id, req.params.id as string, body.reason);

  sendSuccess(res, { ...result });
}

export async function sharePlan(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as SharePlanBody;

  const result = await plansService.sharePlan(user.id, req.params.id as string, body.contact_ids);

  sendSuccess(res, { ...result });
}
