import type { Logger } from 'pino';

import type { AuthenticatedUser } from '@modules/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: AuthenticatedUser;
    }
  }
}

export {};
