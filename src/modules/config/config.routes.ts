import { Router } from 'express';
import type { Request, Response } from 'express';

import { asyncHandler } from '@utils/async-handler';
import { sendSuccess } from '@utils/response';
import { getAppConfig } from './config.service';

/**
 * spec §4.12: no auth. The app fetches this before sign-in to render the mode
 * selector and the sign-up form.
 */
export const configRouter: Router = Router();

configRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, { ...(await getAppConfig()) });
  }),
);
