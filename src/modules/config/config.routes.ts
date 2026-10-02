import { Router } from 'express';
import type { Request, Response } from 'express';

import { asyncHandler } from '@utils/async-handler';
import { sendSuccess } from '@utils/response';
import { getAppConfig } from './config.service';

export const configRouter: Router = Router();

configRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, { ...(await getAppConfig()) });
  }),
);
