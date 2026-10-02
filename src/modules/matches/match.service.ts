import { DISCOVERY } from '@config/constants';
import { type MatchModel, type Mode, type Prisma, SwipeAction } from '@/db/prisma';
import { logger } from '@utils/logger';

export function orderPair(userId: string, otherUserId: string): [string, string] {
  return userId < otherUserId ? [userId, otherUserId] : [otherUserId, userId];
}

export function matchExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + DISCOVERY.MATCH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

export const LIKE_ACTIONS: SwipeAction[] = [SwipeAction.like, SwipeAction.super_like];

export async function lockPair(
  tx: Prisma.TransactionClient,
  userId: string,
  otherUserId: string,
  mode: Mode,
): Promise<void> {
  const [userAId, userBId] = orderPair(userId, otherUserId);
  const key = `match:${userAId}:${userBId}:${mode}`;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export async function createMatchIfMutual(
  tx: Prisma.TransactionClient,
  options: { actorId: string; targetId: string; mode: Mode; isSuperLike: boolean },
): Promise<MatchModel | null> {
  const { actorId, targetId, mode, isSuperLike } = options;

  // Before anything is read, so the reciprocal like below is read after every
  // other transaction on this pair has committed (see `lockPair`).
  await lockPair(tx, actorId, targetId, mode);

  // Mode-scoped deliberately: a like in `dating` must never complete a match in
  // `networking`. This is the single most important filter in the file.
  const reciprocal = await tx.swipe.findUnique({
    where: {
      actor_id_target_id_mode: { actor_id: targetId, target_id: actorId, mode },
    },
    select: { action: true },
  });

  if (!reciprocal || !LIKE_ACTIONS.includes(reciprocal.action)) {
    return null;
  }

  const [userAId, userBId] = orderPair(actorId, targetId);

  const existing = await tx.match.findUnique({
    where: { user_a_id_user_b_id_mode: { user_a_id: userAId, user_b_id: userBId, mode } },
  });

  // The unique index is the last guard. Under the pair lock nothing should get
  // this far with a match already made, but if something does, returning it
  // beats a constraint violation the user would see as a failed swipe.
  if (existing) {
    return existing;
  }

  const paused = await tx.userSettings.count({
    where: { user_id: { in: [actorId, targetId] }, pause_new_matches: true },
  });
  if (paused > 0) {
    return null;
  }

  const match = await tx.match.create({
    data: {
      user_a_id: userAId,
      user_b_id: userBId,
      mode,
      // spec §5.3: a super_like counts as a like for matching and is surfaced
      // to the recipient. Either side super-liking marks the match.
      is_super_like: isSuperLike || reciprocal.action === SwipeAction.super_like,
      expires_at: matchExpiryFrom(),
      conversation: {
        create: {
          mode,
          // One read-state row per participant, created up front so the unread
          // badge and archive flag have somewhere to live from the first
          // message rather than being upserted on every send.
          states: { create: [{ user_id: userAId }, { user_id: userBId }] },
        },
      },
    },
    include: { conversation: { select: { id: true } } },
  });

  logger.info({ match_id: match.id, mode }, 'match created');

  return match;
}
