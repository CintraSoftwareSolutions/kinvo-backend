import { MatchStatus, type NotificationCategory, type Prisma, prisma } from '@/db/prisma';
import type { PushTarget } from '@/providers/push.provider';
import { emitToUser } from '@/realtime/emit';
import { SERVER_EVENTS } from '@/realtime/events';
import { ApiError } from '@utils/api-error';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';
import { getEmailProvider, getPushProvider } from './providers';

export interface NotificationView {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

function toView(notification: {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data: Prisma.JsonValue;
  read_at: Date | null;
  created_at: Date;
}): NotificationView {
  return {
    id: notification.id,
    category: notification.category,
    title: notification.title,
    body: notification.body,
    data: (notification.data ?? {}) as Record<string, unknown>,
    read_at: notification.read_at?.toISOString() ?? null,
    created_at: notification.created_at.toISOString(),
  };
}

export interface CreateNotificationInput {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  emailAddress?: string | null;
}

async function preferencesFor(
  userId: string,
  category: NotificationCategory,
): Promise<{ push: boolean; email: boolean; inApp: boolean }> {
  const row = await prisma.notificationPreference.findUnique({
    where: { user_id_category: { user_id: userId, category } },
  });

  return {
    push: row?.push_enabled ?? true,
    email: row?.email_enabled ?? false,
    inApp: row?.in_app_enabled ?? true,
  };
}

async function pushTokensFor(userId: string): Promise<PushTarget[]> {
  const devices = await prisma.device.findMany({
    where: { user_id: userId, revoked_at: null, fcm_token: { not: null } },
    select: { fcm_token: true, platform: true },
  });

  return devices.flatMap((device) =>
    device.fcm_token === null ? [] : [{ token: device.fcm_token, platform: device.platform }],
  );
}

function stringifyData(data: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
}

export async function notify(input: CreateNotificationInput): Promise<NotificationView> {
  const preferences = await preferencesFor(input.userId, input.category);
  const data = input.data ?? {};
  const notification = await prisma.notification.create({
    data: {
      user_id: input.userId,
      category: input.category,
      title: input.title,
      body: input.body,
      data: data as Prisma.InputJsonValue,
    },
  });

  const view = toView(notification);

  if (preferences.inApp) {
    emitToUser(input.userId, SERVER_EVENTS.NOTIFICATION_NEW, view);
  }

  if (preferences.push) {
    await deliverPush(input.userId, view, stringifyData(data));
  }

  if (preferences.email && input.emailAddress) {
    await getEmailProvider().send({
      to: input.emailAddress,
      subject: input.title,
      text: input.body,
    });
  }

  return view;
}

async function deliverPush(
  userId: string,
  view: NotificationView,
  data: Record<string, string>,
): Promise<void> {
  const tokens = await pushTokensFor(userId);

  if (tokens.length === 0) {
    return;
  }

  const badge = await unreadCount(userId);

  const result = await getPushProvider().send(tokens, {
    title: view.title,
    body: view.body,
    data: { ...data, notification_id: view.id, category: view.category },
    badge,
    // A call is the one notification the app draws itself: it has to ring and
    // cover the lock screen, which a tray banner cannot do.
    drawnByApp: view.category === 'call',
  });

  // A token FCM calls permanently dead is cleared, or every future send retries
  // an address that can never receive anything and the failure count grows
  // forever.
  if (result.invalidTokens.length > 0) {
    await prisma.device.updateMany({
      where: { user_id: userId, fcm_token: { in: result.invalidTokens } },
      data: { fcm_token: null },
    });

    logger.info({ user_id: userId, count: result.invalidTokens.length }, 'cleared dead fcm tokens');
  }
}

export async function notifyMany(
  userIds: string[],
  input: Omit<CreateNotificationInput, 'userId'>,
): Promise<void> {
  await Promise.all(userIds.map((userId) => notify({ ...input, userId })));
}

export async function listNotifications(
  userId: string,
  options: { limit: number; cursor?: string; unread_only?: boolean },
) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.notification.findMany({
    where: {
      user_id: userId,
      ...(options.unread_only ? { read_at: null } : {}),
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  return {
    notifications: page.items.map(toView),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { user_id: userId, read_at: null } });
}

export async function markRead(userId: string, notificationId: string): Promise<NotificationView> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, user_id: userId },
  });

  if (!notification) {
    throw ApiError.notFound();
  }

  if (notification.read_at) {
    return toView(notification);
  }

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { read_at: new Date() },
  });

  return toView(updated);
}

export async function markAllRead(userId: string): Promise<{ marked: number }> {
  const result = await prisma.notification.updateMany({
    where: { user_id: userId, read_at: null },
    data: { read_at: new Date() },
  });

  return { marked: result.count };
}

export interface PreferenceView {
  category: NotificationCategory;
  push_enabled: boolean;
  email_enabled: boolean;
  in_app_enabled: boolean;
}

const ALL_CATEGORIES: NotificationCategory[] = [
  'new_match',
  'new_like',
  'new_message',
  'plan_update',
  'call',
  'verification',
  'safety',
  'moderation',
  'subscription',
  'system',
];

export async function listPreferences(userId: string): Promise<PreferenceView[]> {
  const rows = await prisma.notificationPreference.findMany({ where: { user_id: userId } });
  const byCategory = new Map(rows.map((row) => [row.category, row]));

  return ALL_CATEGORIES.map((category) => {
    const row = byCategory.get(category);

    return {
      category,
      push_enabled: row?.push_enabled ?? true,
      email_enabled: row?.email_enabled ?? false,
      in_app_enabled: row?.in_app_enabled ?? true,
    };
  });
}

const UNMUTABLE: NotificationCategory[] = ['safety'];

export async function updatePreference(
  userId: string,
  category: NotificationCategory,
  input: { push_enabled?: boolean; email_enabled?: boolean; in_app_enabled?: boolean },
): Promise<PreferenceView> {
  if (
    UNMUTABLE.includes(category) &&
    (input.push_enabled === false || input.in_app_enabled === false)
  ) {
    throw ApiError.badRequest('Safety notifications cannot be turned off.', {
      category,
      reason: 'unmutable',
    });
  }

  const row = await prisma.notificationPreference.upsert({
    where: { user_id_category: { user_id: userId, category } },
    create: {
      user_id: userId,
      category,
      push_enabled: input.push_enabled ?? true,
      email_enabled: input.email_enabled ?? false,
      in_app_enabled: input.in_app_enabled ?? true,
    },
    update: {
      ...(input.push_enabled === undefined ? {} : { push_enabled: input.push_enabled }),
      ...(input.email_enabled === undefined ? {} : { email_enabled: input.email_enabled }),
      ...(input.in_app_enabled === undefined ? {} : { in_app_enabled: input.in_app_enabled }),
    },
  });

  return {
    category: row.category,
    push_enabled: row.push_enabled,
    email_enabled: row.email_enabled,
    in_app_enabled: row.in_app_enabled,
  };
}

export interface BadgeCounts {
  discover: number;
  requests: number;
  matches: number;
  plans: number;
  notifications: number;
  total: number;
}

export async function badgeCounts(userId: string): Promise<BadgeCounts> {
  const [deckRemaining, likesReceived, unreadMessages, pendingPlans, unreadNotifications] =
    await Promise.all([
      prisma.deckEntry.count({
        where: { consumed_at: null, deck: { user_id: userId } },
      }),
      prisma.swipe.count({
        where: {
          target_id: userId,
          action: { in: ['like', 'super_like'] },
          NOT: { actor: { swipes_received: { some: { actor_id: userId } } } },
        },
      }),
      prisma.conversationState.aggregate({
        where: {
          user_id: userId,
          conversation: { match: { status: MatchStatus.active } },
        },
        _sum: { unread_count: true },
      }),
      prisma.plan.count({
        where: {
          status: 'proposed',
          // Only plans awaiting THIS user's answer. A plan this user proposed
          // is pending for the other person, not a badge on their own tab.
          NOT: { creator_id: userId },
          // One whose time has passed can no longer be accepted.
          scheduled_at: { gt: new Date() },
          // As the Plans tab lists them: not with an account that was
          // deleted or suspended.
          match: {
            OR: [{ user_a_id: userId }, { user_b_id: userId }],
            user_a: { deleted_at: null, status: 'active' },
            user_b: { deleted_at: null, status: 'active' },
          },
        },
      }),
      unreadCount(userId),
    ]);

  const messages = unreadMessages._sum.unread_count ?? 0;

  return {
    discover: deckRemaining,
    requests: likesReceived,
    matches: messages,
    plans: pendingPlans,
    notifications: unreadNotifications,
    // Deliberately excludes `discover`: cards waiting is not something the user
    // is behind on, and folding it into a total makes the app badge permanently
    // non-zero.
    total: likesReceived + messages + pendingPlans + unreadNotifications,
  };
}
