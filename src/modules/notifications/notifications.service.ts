import { MatchStatus, type NotificationCategory, type Prisma, prisma } from '@/db/prisma';
import { emitToUser } from '@/realtime/emit';
import { ApiError } from '@utils/api-error';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';
import { getEmailProvider, getPushProvider } from './providers';

/**
 * Notifications (spec §5, §7, Batch 11).
 *
 * THE RULE: every notification is persisted to the feed AND pushed. Never
 * pushed alone.
 *
 * The Notifications screen reads the feed, so a push-only notification
 * disappears the instant the user swipes the banner away — and someone who
 * dismissed a "new match" banner has no other route back to it. Persisting
 * first also means push, email, and socket delivery are all best-effort: any
 * of them can fail without losing anything.
 */

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
  /** Deep-link payload. Coerced to strings for push, kept as-is in the feed. */
  data?: Record<string, unknown>;
  /** Set for a notification the user should never receive by email. */
  emailAddress?: string | null;
}

/**
 * Per-category delivery settings, defaulted rather than required.
 *
 * A user who has never opened notification settings has no rows, and a missing
 * row must mean "the sensible default" — not "off". Defaulting to off would
 * silently disable notifications for every existing account the day this
 * shipped.
 */
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

/** Live tokens for a user's connected devices. */
async function pushTokensFor(userId: string): Promise<string[]> {
  const devices = await prisma.device.findMany({
    where: { user_id: userId, revoked_at: null, fcm_token: { not: null } },
    select: { fcm_token: true },
  });

  return devices
    .map((device) => device.fcm_token)
    .filter((token): token is string => token !== null);
}

function stringifyData(data: Record<string, unknown>): Record<string, string> {
  // FCM rejects a data payload whose values are not strings, and does it with
  // an error that names neither the key nor the type.
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
}

/**
 * Creates a notification and attempts every enabled channel.
 *
 * Returns the persisted record. Delivery failures are logged, never thrown —
 * the caller is usually mid-way through a business action (a match forming, a
 * message sending) and must not have it fail because a banner did not arrive.
 */
export async function notify(input: CreateNotificationInput): Promise<NotificationView> {
  const preferences = await preferencesFor(input.userId, input.category);
  const data = input.data ?? {};

  // PERSIST FIRST. Everything below this line is delivery.
  //
  // in_app_enabled off still writes the row: the preference controls whether
  // the app surfaces it, not whether it happened. Dropping the record instead
  // would make "turn notifications back on" lose history.
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

  // Socket first — a connected client updates instantly and needs no push.
  if (preferences.inApp) {
    emitToUser(input.userId, 'notification:new', view);
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

/** Notifies several people with the same content, without N round trips of setup. */
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

  // Scoped to the caller: another user's notification id is a 404, never a 403
  // that would confirm it exists.
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
  'safety',
  'moderation',
  'subscription',
  'system',
];

/**
 * Every category, with defaults filled in for the ones the user has never
 * touched — so the settings screen renders from one call and never has to know
 * what the defaults are.
 */
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

/**
 * Safety notifications cannot be switched off.
 *
 * spec §5.7: these carry emergency and moderation outcomes. A user who muted
 * "safety" a month ago and misses the notification that someone they reported
 * was actioned is the exact failure this product cannot have.
 */
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

/**
 * Counts for all five tabs in one call (spec §7, Batch 11).
 *
 * One query per tab, run together. The app polls this on resume, so five
 * separate endpoints would be five round trips on every foreground.
 */
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
          match: { OR: [{ user_a_id: userId }, { user_b_id: userId }] },
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
