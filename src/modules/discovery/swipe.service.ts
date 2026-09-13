import { type MatchModel, type Mode, Prisma, SwipeAction, prisma } from '@/db/prisma';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';
import { requireFeature } from '@modules/entitlements/entitlements.service';
import { consumeQuota, refundQuota } from '@modules/entitlements/quota.service';
import { createMatchIfMutual, deleteMatchForPair } from '@modules/matches/match.service';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { assertVisible, getBlockedUserIds, visibleUserFilter } from '@modules/safety/block.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';
import { emitMatch } from '@/realtime/emit';
import { notify } from '@modules/notifications/notifications.service';
import { consumeDeckEntry, requireEnabledMode, restoreDeckEntry } from './deck.service';

/**
 * Swiping, rewind, and the likes-you inbox (spec §5.3, Batch 7).
 *
 * Swipe uniqueness is `(actor, target, mode)`. The same pair may like in one
 * mode and pass in another, and a mutual like only matches within the mode it
 * happened in.
 */

/**
 * Which actions cost quota.
 *
 * Likes and super likes only. A pass costs nothing, because capping passes
 * strands a free user on a profile they do not want and extracts no value —
 * the cap exists to sell subscriptions, and nobody has ever paid to skip
 * someone faster. This reads the spec's "daily swipe cap" as a cap on the
 * actions that can lead to a match; see DECISIONS.md §1.2e.
 */
const QUOTA_ACTIONS: SwipeAction[] = [SwipeAction.like, SwipeAction.super_like];

export interface SwipeResult {
  action: SwipeAction;
  is_match: boolean;
  match: { id: string; mode: Mode; is_super_like: boolean; matched_at: string } | null;
  quota: { limit: number; used: number; remaining: number; is_unlimited: boolean };
}

/**
 * Confirms the target is swipeable in this mode.
 *
 * Everything that fails here answers 404, byte-identical to a user that never
 * existed (spec §4.4). A 403 would confirm the account is real, and "they
 * blocked you", "they are suspended" and "they left this mode" must be
 * indistinguishable from outside.
 */
async function assertSwipeableTarget(actorId: string, targetId: string, mode: Mode): Promise<void> {
  if (actorId === targetId) {
    throw ApiError.validation({ target_id: ['You cannot swipe on yourself.'] });
  }

  // The shared clause first: blocks beat everything (spec §5.5).
  await assertVisible(actorId, targetId);

  const target = await prisma.user.findFirst({
    where: {
      id: targetId,
      onboarded_at: { not: null },
      user_modes: { some: { mode, is_enabled: true } },
    },
    select: { id: true },
  });

  if (!target) {
    throw ApiError.notFound();
  }
}

export async function swipe(
  actorId: string,
  mode: Mode,
  targetId: string,
  action: SwipeAction,
): Promise<SwipeResult> {
  await requireEnabledMode(actorId, mode);
  await assertSwipeableTarget(actorId, targetId, mode);

  const costsQuota = QUOTA_ACTIONS.includes(action);

  // Consumed BEFORE the transaction because Redis and Postgres cannot commit
  // together, and refunded below if the write fails. The alternative — writing
  // first and charging after — hands out free likes whenever Redis blips.
  const quota = costsQuota
    ? await consumeQuota(actorId, 'swipes')
    : { limit: -1, used: 0, remaining: -1, is_unlimited: true };

  let match: MatchModel | null = null;

  try {
    match = await prisma.$transaction(async (tx) => {
      await tx.swipe.create({
        data: { actor_id: actorId, target_id: targetId, mode, action },
      });

      await consumeDeckEntry(tx, actorId, mode, targetId);

      if (!costsQuota) {
        return null;
      }

      return createMatchIfMutual(tx, {
        actorId,
        targetId,
        mode,
        isSuperLike: action === SwipeAction.super_like,
      });
    });
  } catch (error) {
    // Never charge for a swipe the database rejected.
    if (costsQuota) {
      await refundQuota(actorId, 'swipes');
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ApiError(
        ERROR_CODES.CONFLICT,
        'You have already swiped on this person in this mode.',
      );
    }

    throw error;
  }

  // PERSIST FIRST, THEN EMIT (spec §7). Outside the transaction, so a rollback
  // cannot leave both people notified of a match that does not exist.
  if (match) {
    await announceMatch(match, actorId, targetId);
  } else if (costsQuota) {
    // A like that did not complete a match. Only the target hears about it, and
    // only that it happened.
    await announceLike(targetId, mode, action === SwipeAction.super_like);
  }

  return {
    action,
    is_match: match !== null,
    match: match
      ? {
          id: match.id,
          mode: match.mode,
          is_super_like: match.is_super_like,
          matched_at: match.matched_at.toISOString(),
        }
      : null,
    quota: {
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
      is_unlimited: quota.is_unlimited,
    },
  };
}

export interface RewindResult {
  restored_user_id: string;
  action: SwipeAction;
  match_removed: boolean;
}

/**
 * Reverses the last swipe in this mode, restoring the profile to the deck
 * (spec §5.3).
 *
 * If that swipe created a match, the match goes too. The alternative — keeping
 * a match whose originating swipe no longer exists — leaves a conversation
 * neither person can trace and a pair that can never re-match, because the
 * unique index still holds the row.
 */
export async function rewind(userId: string, mode: Mode): Promise<RewindResult> {
  await requireEnabledMode(userId, mode);
  await requireFeature(userId, ENTITLEMENT_KEYS.REWIND, 'Rewind is available with Premium.');

  const last = await prisma.swipe.findFirst({
    where: { actor_id: userId, mode },
    orderBy: { created_at: 'desc' },
    select: { id: true, target_id: true, action: true },
  });

  if (!last) {
    throw ApiError.notFound('There is nothing to rewind in this mode.');
  }

  const matchRemoved = await prisma.$transaction(async (tx) => {
    await tx.swipe.delete({ where: { id: last.id } });
    await restoreDeckEntry(tx, userId, mode, last.target_id);

    return deleteMatchForPair(tx, { actorId: userId, targetId: last.target_id, mode });
  });

  // The swipe no longer exists, so the allowance it spent is given back.
  if (QUOTA_ACTIONS.includes(last.action)) {
    await refundQuota(userId, 'swipes');
  }

  logger.info({ user_id: userId, mode, match_removed: matchRemoved }, 'swipe rewound');

  return { restored_user_id: last.target_id, action: last.action, match_removed: matchRemoved };
}

export interface LikeReceived {
  swipe_id: string;
  is_super_like: boolean;
  liked_at: string;
  user: UserCompact;
}

/**
 * The likes-you inbox — decision #5: profiles, not messages.
 *
 * Excludes anyone the viewer has already swiped on in this mode: that like
 * either became a match or was passed on, and either way it is no longer a
 * pending request.
 */
export async function likesYou(
  userId: string,
  mode: Mode,
  options: { limit: number; cursor?: string },
): Promise<{
  likes: LikeReceived[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}> {
  await requireEnabledMode(userId, mode);
  await requireFeature(
    userId,
    ENTITLEMENT_KEYS.SEE_WHO_LIKED_YOU,
    'Seeing who liked you is available with Premium.',
  );

  const blockedUserIds = await getBlockedUserIds(userId);
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.swipe.findMany({
    where: {
      target_id: userId,
      mode,
      action: { in: QUOTA_ACTIONS },
      // Blocks beat everything, including a like that arrived before the block.
      actor: visibleUserFilter(userId, blockedUserIds),
      // Already answered: it is a match or a pass, not a pending request.
      //
      // Read carefully: this asks whether the ACTOR RECEIVED a swipe FROM the
      // viewer. Phrasing it as the actor's own swipes_made matches the very
      // like being listed, and every admirer silently excludes themselves.
      NOT: { actor: { swipes_received: { some: { actor_id: userId, mode } } } },
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
    select: {
      id: true,
      action: true,
      created_at: true,
      actor: { select: USER_COMPACT_SELECT },
    },
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  const photoUrls = await getPrimaryPhotoUrlsFor(page.items.map((row) => row.actor.id));

  return {
    likes: page.items.map((row) => ({
      swipe_id: row.id,
      is_super_like: row.action === SwipeAction.super_like,
      liked_at: row.created_at.toISOString(),
      user: toUserCompact(row.actor, photoUrls.get(row.actor.id) ?? null),
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

/** Count only — for a badge, without paying for the whole list or the paywall. */
export async function countLikesYou(userId: string, mode: Mode): Promise<number> {
  const blockedUserIds = await getBlockedUserIds(userId);

  return prisma.swipe.count({
    where: {
      target_id: userId,
      mode,
      action: { in: QUOTA_ACTIONS },
      actor: visibleUserFilter(userId, blockedUserIds),
      NOT: { actor: { swipes_received: { some: { actor_id: userId, mode } } } },
    },
  });
}

/**
 * Tells both people about a new match.
 *
 * Each side is sent the OTHER person, so the payload is directly renderable
 * without the client working out which half of the pair it is looking at.
 */
async function announceMatch(match: MatchModel, actorId: string, targetId: string): Promise<void> {
  const [users, photoUrls, conversation] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [actorId, targetId] } },
      select: USER_COMPACT_SELECT,
    }),
    getPrimaryPhotoUrlsFor([actorId, targetId]),
    prisma.conversation.findUnique({
      where: { match_id: match.id },
      select: { id: true },
    }),
  ]);

  const byId = new Map(users.map((user) => [user.id, user]));

  for (const [recipient, other] of [
    [actorId, targetId],
    [targetId, actorId],
  ] as const) {
    const otherUser = byId.get(other);

    if (!otherUser) {
      continue;
    }

    emitMatch(recipient, {
      match_id: match.id,
      conversation_id: conversation?.id ?? null,
      mode: match.mode,
      is_super_like: match.is_super_like,
      matched_at: match.matched_at.toISOString(),
      expires_at: match.expires_at.toISOString(),
      user: toUserCompact(otherUser, photoUrls.get(other) ?? null),
    });

    // Persisted to the feed as well as pushed. A socket event reaches only a
    // connected client, and a push banner is gone once dismissed — the feed is
    // the only place a match notification can still be found tomorrow.
    await notify({
      userId: recipient,
      category: 'new_match',
      title: 'It is a match!',
      body: `You and ${otherUser.display_name} liked each other.`,
      data: { match_id: match.id, mode: match.mode, user_id: other },
    });
  }
}

/**
 * Tells someone they were liked, WITHOUT saying by whom.
 *
 * Who liked you is behind a paywall (see `likesYou`). Naming them here would
 * give the feature away in a push banner, so the notification carries a count
 * and a deep link to the paywalled screen.
 */
async function announceLike(targetId: string, mode: Mode, isSuperLike: boolean): Promise<void> {
  await notify({
    userId: targetId,
    category: 'new_like',
    title: isSuperLike ? 'Someone super liked you' : 'Someone liked you',
    body: 'Open Kinvo to see who it is.',
    data: { mode, is_super_like: isSuperLike },
  });
}
