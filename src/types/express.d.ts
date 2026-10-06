import type { Logger } from 'pino';

import type { AuthenticatedUser } from '@modules/auth/auth.types';
import type { EffectivePermissions } from '@middleware/require-permission';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: AuthenticatedUser;
      /**
       * Set by `requirePermission` so a handler can report what the caller may
       * do without resolving it a second time. Present only on admin routes.
       */
      adminPermissions?: EffectivePermissions;
    }
  }
}

export {};
