import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import * as entitlementsService from '@modules/entitlements/entitlements.service';
import type { EntitlementKey } from '@modules/entitlements/entitlements.types';

export function requireEntitlement(key: EntitlementKey, message?: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = requireUser(req);

    entitlementsService
      .requireFeature(user.id, key, message)
      .then(() => next())
      .catch(next);
  };
}
