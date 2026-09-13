import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import * as entitlementsService from '@modules/entitlements/entitlements.service';
import type { EntitlementKey } from '@modules/entitlements/entitlements.types';

/**
 * Gates a route on a boolean entitlement (spec §5.11, Batch 6).
 *
 *   router.post('/rewind', authenticate, requireEntitlement('rewind'), handler)
 *
 * Mount AFTER `authenticate` — it reads the resolved user, and running it first
 * would throw an unauthenticated error from the wrong layer.
 *
 * Answers 403 PREMIUM_REQUIRED with the paywall context in `details`. Numeric
 * allowances are not gated here: a daily cap must be consumed inside the
 * transaction that performs the action so it can be refunded if that action
 * fails, which middleware cannot do. Those call `consumeQuota` in the service.
 */
export function requireEntitlement(key: EntitlementKey, message?: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = requireUser(req);

    entitlementsService
      .requireFeature(user.id, key, message)
      .then(() => next())
      .catch(next);
  };
}
