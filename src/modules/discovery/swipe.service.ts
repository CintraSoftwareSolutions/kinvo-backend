import { type MatchModel, type Mode, Prisma, SwipeAction, prisma } from '@/db/prisma';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';
import { requireFeature } from '@modules/entitlements/entitlements.service';
import { consumeQuota, refundQuota } from '@modules/entitlements/quota.service';
import {
  LIKE_ACTIONS,
  createMatchIfMutual,
  deleteMatchForPair,
  orderPair,
} from '@modules/matches/match.service';
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
import { assertIncognitoAllows } from './incognito';

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
  // Someone incognito can't be acted on by people they haven't shown themselves
  // to — the card was never on their deck — and the answer is the same 404.
  await assertIncognitoAllows(actorId, targetId, { mode });

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

/**
 * Refuses a like from someone who has paused new matches (DECISIONS.md, 24
 * Sep 2026). Stopping new matches is the whole of what they asked for, and a
 * like is how one starts. Passing is still allowed: it starts nothing.
 *
 * Before the quota is touched, so a refused like costs nothing.
 */
async function assertTakingNewMatches(userId: string): Promise<void> {
  const settings = await prisma.userSettings.findUnique({
    where: { user_id: userId },
    select: { pause_new_matches: true },
  });

  if (settings?.pause_new_matches) {
    throw new ApiError(ERROR_CODES.NEW_MATCHES_PAUSED);
  }
}

export async function swipe(
  actorId: string,
  mode: Mode,
  targetId: string,
  action: SwipeAction,
): Promise<SwipeResult> {
  await requireEnabledMode(actorId, mode);

  const costsQuota = QUOTA_ACTIONS.includes(action);
  if (costsQuota) {
    await assertTakingNewMatches(actorId);
  }

  await assertSwipeableTarget(actorId, targetId, mode);

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
      // The conversation too, so tapping the notification opens it directly.
      data: {
        match_id: match.id,
        ...(conversation ? { conversation_id: conversation.id } : {}),
        mode: match.mode,
        user_id: other,
      },
    });
  }
}

/**
 * Makes the matches a pause held back (DECISIONS.md, 24 Sep 2026).
 *
 * While either person has paused new matches, a like that would have
 * completed a match is recorded and makes nothing — `createMatchIfMutual`
 * refuses. Neither can swipe on the other again (a swipe is unique per pair
 * and mode), so without this the pair would be stranded for good. Called when
 * [userId]'s pause ends: every pair that liked each other in the same mode,
 * has never had a match, can still see each other and still has the mode on,
 * becomes a match now — and both hear about it as they would have then.
 *
 * A pair whose other half is still paused stays waiting; their own unpause
 * makes it.
 */
export async function matchLikesHeldByPause(userId: string): Promise<number> {
  const [given, received] = await Promise.all([
    prisma.swipe.findMany({
      where: { actor_id: userId, action: { in: LIKE_ACTIONS } },
      select: { target_id: true, mode: true, action: true },
    }),
    prisma.swipe.findMany({
      where: { target_id: userId, action: { in: LIKE_ACTIONS } },
      select: { actor_id: true, mode: true },
    }),
  ]);

  const likedBack = new Set(received.map((swipe) => `${swipe.actor_id}:${swipe.mode}`));
  const mutual = given.filter((swipe) => likedBack.has(`${swipe.target_id}:${swipe.mode}`));
  if (mutual.length === 0) return 0;

  // Only people still in reach — the shared clause decides that, with snoozed
  // people kept, as they are for existing matches — in modes both still have on.
  const blockedUserIds = await getBlockedUserIds(userId);
  const [reachable, own] = await Promise.all([
    prisma.user.findMany({
      where: {
        AND: [
          visibleUserFilter(userId, blockedUserIds, { includeSnoozed: true }),
          { id: { in: [...new Set(mutual.map((swipe) => swipe.target_id))] } },
        ],
      },
      select: { id: true, user_modes: { where: { is_enabled: true }, select: { mode: true } } },
    }),
    prisma.userMode.findMany({
      where: { user_id: userId, is_enabled: true },
      select: { mode: true },
    }),
  ]);
  const ownModes = new Set(own.map((row) => row.mode));
  const theirModes = new Map(
    reachable.map((user) => [user.id, new Set(user.user_modes.map((row) => row.mode))]),
  );

  let made = 0;
  for (const { target_id: otherId, mode, action } of mutual) {
    if (!ownModes.has(mode) || !theirModes.get(otherId)?.has(mode)) continue;

    const match = await prisma.$transaction(async (tx) => {
      // A pair that has had a match — even one that has since ended — is never
      // matched again by this. Unmatching is a decision; this is not a path
      // around it.
      const [userAId, userBId] = orderPair(userId, otherId);
      const existing = await tx.match.findUnique({
        where: { user_a_id_user_b_id_mode: { user_a_id: userAId, user_b_id: userBId, mode } },
        select: { id: true },
      });
      if (existing) return null;

      return createMatchIfMutual(tx, {
        actorId: userId,
        targetId: otherId,
        mode,
        isSuperLike: action === SwipeAction.super_like,
      });
    });

    // Null when the other side is paused too: their unpause will make it.
    if (!match) continue;

    await announceMatch(match, userId, otherId);
    made++;
  }

  logger.info({ user_id: userId, matches: made }, 'matches held by a pause made');
  return made;
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
