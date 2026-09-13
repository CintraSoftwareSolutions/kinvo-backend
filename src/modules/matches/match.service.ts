import { DISCOVERY } from '@config/constants';
import { type MatchModel, type Mode, type Prisma, SwipeAction } from '@/db/prisma';
import { logger } from '@utils/logger';

/**
 * Match creation (spec §5.3, Batch 7).
 *
 * Batch 8 builds the REST surface — listing, unmatching, extending. This file
 * owns only the rule that turns two swipes into a match, because that rule
 * belongs to the swipe transaction and must not be duplicated there.
 *
 * A match belongs to EXACTLY ONE MODE. The same two people may match in
 * `dating` and in `study_buddy` and those are two independent matches with two
 * independent conversations. Nothing here may be written in a way that treats a
 * pair as globally matched.
 */

/**
 * The pair, ordered.
 *
 * `matches_user_order_check` in the migration enforces `user_a_id < user_b_id`.
 * Without a canonical order the same pair could be inserted twice — once as
 * (A,B) and once as (B,A) — and the unique index would not stop it, so both
 * users would see duplicate matches for the same relationship.
 */
export function orderPair(userId: string, otherUserId: string): [string, string] {
  return userId < otherUserId ? [userId, otherUserId] : [otherUserId, userId];
}

export function matchExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + DISCOVERY.MATCH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

const LIKE_ACTIONS: SwipeAction[] = [SwipeAction.like, SwipeAction.super_like];

/**
 * Creates a match when the target has already liked the actor IN THE SAME MODE.
 *
 * Runs inside the caller's transaction so a match and the swipe that caused it
 * commit together. A match that exists without its swipe would be un-rewindable
 * and would reappear in nobody's deck.
 *
 * Returns null when there is no reciprocal like — the ordinary case.
 */
export async function createMatchIfMutual(
  tx: Prisma.TransactionClient,
  options: { actorId: string; targetId: string; mode: Mode; isSuperLike: boolean },
): Promise<MatchModel | null> {
  const { actorId, targetId, mode, isSuperLike } = options;

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

  // Two simultaneous likes both find a reciprocal one. The unique index is the
  // real guard; this makes the second caller return the same match rather than
  // raising a constraint violation the user would see as a failed swipe.
  if (existing) {
    return existing;
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
      // Decision #5: users cannot message before matching, so a conversation
      // always has a match behind it. Creating it here rather than lazily on
      // first message means a match can never exist without somewhere to talk,
      // and the chat module never has to handle a missing conversation.
      //
      // Decision #11: exactly two participants, always — the pair on the match.
      // Study Buddy groups are out of scope for v1.
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

/**
 * Removes the match a swipe created, for rewind.
 *
 * Deleting rather than soft-deleting: rewind restores the pre-swipe state, and
 * a lingering unmatched row would block the pair from ever matching again in
 * this mode through the unique index.
 */
export async function deleteMatchForPair(
  tx: Prisma.TransactionClient,
  options: { actorId: string; targetId: string; mode: Mode },
): Promise<boolean> {
  const [userAId, userBId] = orderPair(options.actorId, options.targetId);

  const deleted = await tx.match.deleteMany({
    where: { user_a_id: userAId, user_b_id: userBId, mode: options.mode },
  });

  return deleted.count > 0;
}
