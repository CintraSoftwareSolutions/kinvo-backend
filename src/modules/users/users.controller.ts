import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import * as profiles from '@modules/profiles/profiles.service';
import { sendSuccess } from '@utils/response';
import * as onboarding from './onboarding.service';
import type {
  SetDateOfBirthBody,
  SetInterestsBody,
  SetPromptsBody,
  UpdateLocationBody,
  UpdateProfileBody,
} from './users.schema';
import * as users from './users.service';

/**
 * HTTP translation only — no business logic, no database access (spec §0.5).
 */

export async function getMe(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  sendSuccess(res, { ...(await profiles.getOwnProfile(user.id)) });
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as UpdateProfileBody;

  sendSuccess(res, { ...(await profiles.updateProfile(user.id, body)) });
}

export async function updateLocation(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as UpdateLocationBody;

  const profile = await profiles.updateLocation(
    user.id,
    { longitude: body.longitude, latitude: body.latitude },
    { city: body.city, country: body.country },
  );

  sendSuccess(res, { ...profile });
}

export async function setInterests(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as SetInterestsBody;

  sendSuccess(res, { ...(await profiles.setInterests(user.id, body.interests)) });
}

export async function setPrompts(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as SetPromptsBody;

  sendSuccess(res, { ...(await profiles.setPrompts(user.id, body.prompts)) });
}

export async function getPreview(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  sendSuccess(res, { ...(await profiles.getOwnPreview(user.id)) });
}

export async function getPublicProfile(req: Request, res: Response): Promise<void> {
  const viewer = requireUser(req);
  const targetId = req.params.id!;

  sendSuccess(res, { ...(await profiles.getPublicProfile(viewer.id, targetId)) });
}

export async function deleteMe(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  sendSuccess(res, { ...(await users.deleteAccount(user.id)) });
}

export async function getOnboarding(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  sendSuccess(res, { ...(await onboarding.getOnboardingStatus(user.id)) });
}

export async function completeOnboarding(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  sendSuccess(res, { ...(await onboarding.completeOnboarding(user.id)) });
}

export async function setDateOfBirth(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as SetDateOfBirthBody;

  await onboarding.setDateOfBirth(user.id, body.date_of_birth);
  sendSuccess(res, { ...(await onboarding.getOnboardingStatus(user.id)) });
}
