import type { Logger } from 'pino';

import type { AuthenticatedUser } from '@modules/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Set by the requestId middleware. */
      id: string;
      /** Request-scoped child logger carrying `request_id`. */
      log: Logger;
      /**
       * Set by `authenticate`, and by `optionalAuth` when a valid token is
       * present. Optional because unauthenticated routes exist — anything
       * behind `authenticate` can rely on it, and `requireUser(req)` narrows
       * the type without a non-null assertion at every call site.
       */
      user?: AuthenticatedUser;
    }
  }
}

export {};
