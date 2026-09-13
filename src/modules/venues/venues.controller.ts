import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendSuccess } from '@utils/response';
import * as venuesService from './venues.service';
import type { SearchVenuesQuery } from './venues.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function searchVenues(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const query = req.query as unknown as SearchVenuesQuery;

  const venues = await venuesService.searchVenues(user.id, query);

  sendSuccess(res, { venues });
}

export async function getVenue(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await venuesService.getVenue(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

export async function listSaved(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const venues = await venuesService.listSavedVenues(user.id);

  sendSuccess(res, { venues });
}

export async function saveVenue(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  await venuesService.saveVenue(user.id, req.params.id as string);

  sendSuccess(res, { saved: true }, 201);
}

export async function unsaveVenue(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  await venuesService.unsaveVenue(user.id, req.params.id as string);

  sendSuccess(res, { saved: false });
}

export async function suggestForMatch(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const venues = await venuesService.suggestForMatch(user.id, req.params.match_id as string);

  sendSuccess(res, { venues });
}
