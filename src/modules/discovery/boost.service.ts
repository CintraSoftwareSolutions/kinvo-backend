import { DISCOVERY } from '@config/constants';
import { MatchStatus, type Mode, SwipeAction, prisma } from '@/db/prisma';
import { requireFeature } from '@modules/entitlements/entitlements.service';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';
import { checkQuota } from '@modules/entitlements/quota.service';
import { getBlockedUserIds } from '@modules/safety/block.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { countLikesYou } from './swipe.service';
import { deckCandidateFilter, deckDateFor, requireEnabledMode } from './deck.service';

export interface BoostView {
  id: string;
  mode: Mode;
  started_at: string;
  ends_at: string;
  is_active: boolean;
}

export async function activeBoost(userId: string, mode: Mode): Promise<BoostView | null> {
  const boost = await prisma.boost.findFirst({
    where: { user_id: userId, mode, ends_at: { gt: new Date() } },
    orderBy: { ends_at: 'desc' },
  });

  return boost
    ? {
        id: boost.id,
        mode: boost.mode,
        started_at: boost.started_at.toISOString(),
        ends_at: boost.ends_at.toISOString(),
        is_active: true,
      }
    : null;
}

export async function startBoost(userId: string, mode: Mode): Promise<BoostView> {
  await requireEnabledMode(userId, mode);
  await requireFeature(userId, ENTITLEMENT_KEYS.BOOST, 'Boost is available with Premium.');

  const running = await activeBoost(userId, mode);

  if (running) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'A boost is already running in this mode.', {
      ends_at: running.ends_at,
    });
  }

  const now = new Date();
  const boost = await prisma.boost.create({
    data: {
      user_id: userId,
      mode,
      started_at: now,
      ends_at: new Date(now.getTime() + DISCOVERY.BOOST_DURATION_MINUTES * 60 * 1000),
    },
  });

  logger.info({ user_id: userId, mode }, 'boost started');

  return {
    id: boost.id,
    mode: boost.mode,
    started_at: boost.started_at.toISOString(),
    ends_at: boost.ends_at.toISOString(),
    is_active: true,
  };
}

export interface DeckStats {
  mode: Mode;
  liked: number;
  passed: number;
  super_liked: number;
  matches: number;
  likes_received: number;
  cards_remaining: number;
  boost: BoostView | null;
  swipe_quota: { limit: number; used: number; remaining: number; is_unlimited: boolean };
}

export async function deckStats(userId: string, mode: Mode): Promise<DeckStats> {
  await requireEnabledMode(userId, mode);
  const blockedUserIds = await getBlockedUserIds(userId);

  const [swipeCounts, matches, likesReceived, cardsRemaining, boost, quota] = await Promise.all([
    prisma.swipe.groupBy({
      by: ['action'],
      where: { actor_id: userId, mode },
      _count: { _all: true },
    }),
    prisma.match.count({
      where: {
        mode,
        status: MatchStatus.active,
        OR: [{ user_a_id: userId }, { user_b_id: userId }],
      },
    }),
    countLikesYou(userId, mode),
    prisma.deckEntry.count({
      where: {
        consumed_at: null,
        deck: { user_id: userId, mode, deck_date: deckDateFor() },
        // Only the cards a deck read would actually return.
        target: deckCandidateFilter(userId, mode, blockedUserIds),
      },
    }),
    activeBoost(userId, mode),
    checkQuota(userId, 'swipes'),
  ]);

  const countFor = (action: SwipeAction): number =>
    swipeCounts.find((row) => row.action === action)?._count._all ?? 0;

  return {
    mode,
    liked: countFor(SwipeAction.like),
    passed: countFor(SwipeAction.pass),
    super_liked: countFor(SwipeAction.super_like),
    matches,
    likes_received: likesReceived,
    cards_remaining: cardsRemaining,
    boost,
    swipe_quota: {
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
      is_unlimited: quota.is_unlimited,
    },
  };
}
