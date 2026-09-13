import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendSuccess } from '@utils/response';
import * as entitlementsService from './entitlements.service';
import * as quotaService from './quota.service';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function getMyEntitlements(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const [{ tier, flags }, quotas] = await Promise.all([
    entitlementsService.resolve(user.id),
    quotaService.checkAllQuotas(user.id),
  ]);

  sendSuccess(res, {
    tier,
    flags,
    quotas,
    // So the app can hide every upgrade affordance on the top tier without
    // hard-coding which tier that is — the tier ladder is server-side data.
    upgrade_available: tier !== 'advanced',
  });
}
