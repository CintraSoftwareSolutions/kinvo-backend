import type { Request, Response } from 'express';

import type { NotificationCategory } from '@/db/prisma';
import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as notificationsService from './notifications.service';
import * as tokensService from './push-tokens.service';
import type {
  ListQuery,
  RegisterPushTokenBody,
  UpdatePreferenceBody,
} from './notifications.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function listNotifications(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor, unread_only } = req.query as unknown as ListQuery;

  const result = await notificationsService.listNotifications(user.id, {
    limit,
    cursor,
    unread_only,
  });

  sendList(res, result.notifications, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await notificationsService.markRead(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await notificationsService.markAllRead(user.id);

  sendSuccess(res, { ...result });
}

export async function unreadCount(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const count = await notificationsService.unreadCount(user.id);

  // spec §4.6: `data` is an object or array, never a bare scalar.
  sendSuccess(res, { unread_count: count });
}

export async function badges(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await notificationsService.badgeCounts(user.id);

  sendSuccess(res, { ...result });
}

export async function listPreferences(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const preferences = await notificationsService.listPreferences(user.id);

  sendSuccess(res, { preferences });
}

export async function updatePreference(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const category = req.params.category as NotificationCategory;
  const body = req.body as UpdatePreferenceBody;

  const result = await notificationsService.updatePreference(user.id, category, body);

  sendSuccess(res, { ...result });
}

export async function registerPushToken(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as RegisterPushTokenBody;

  const result = await tokensService.registerPushToken(user.id, body.device_id, body.fcm_token);

  sendSuccess(res, { ...result });
}

export async function unregisterPushToken(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  await tokensService.unregisterPushToken(user.id, req.params.device_id as string);

  sendSuccess(res, { unregistered: true });
}
