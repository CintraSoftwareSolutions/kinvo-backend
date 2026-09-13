import type { Request, Response } from 'express';

import { CLIENT_HEADERS } from '@config/constants';
import { requireUser } from '@middleware/authenticate';
import { sendSuccess } from '@utils/response';
import * as devicesService from './devices.service';
import type { SnoozeBody, UpdateSettingsBody } from './settings.schema';
import * as settingsService from './settings.service';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

/** The stable per-install id the app sends on every request (spec §4.11). */
function currentDeviceId(req: Request): string | undefined {
  return req.get(CLIENT_HEADERS.DEVICE_ID) ?? undefined;
}

export async function getSettings(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const settings = await settingsService.getSettings(user.id);
  sendSuccess(res, { ...settings });
}

export async function updateSettings(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as UpdateSettingsBody;

  const settings = await settingsService.updateSettings(user.id, body);
  sendSuccess(res, { ...settings });
}

export async function snooze(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as SnoozeBody;

  const endsAt = body.ends_at ? new Date(body.ends_at) : null;
  const settings = await settingsService.snooze(user.id, endsAt);
  sendSuccess(res, { ...settings });
}

export async function unsnooze(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const settings = await settingsService.unsnooze(user.id);
  sendSuccess(res, { ...settings });
}

export async function listDevices(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const devices = await devicesService.listDevices(user.id, currentDeviceId(req));

  // spec §4.6: a list is always an array, never null.
  sendSuccess(res, { devices });
}

export async function revokeDevice(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  await devicesService.revokeDevice(user.id, req.params.id!);
  sendSuccess(res, { revoked: true });
}

export async function revokeOtherDevices(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const count = await devicesService.revokeOtherDevices(user.id, currentDeviceId(req));

  // spec §4.2: scalars are wrapped, never returned bare.
  sendSuccess(res, { revoked_count: count });
}
