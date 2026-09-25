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

export const LIKE_ACTIONS: SwipeAction[] = [SwipeAction.like, SwipeAction.super_like];

/**
 * Holds the pair's lock until the caller's transaction ends.
 *
 * Everything that can make a match for one pair in one mode, or take away the
 * like it rests on, takes this first: a like, the matches a pause held back,
 * and rewind. Without it, READ COMMITTED lets two likes that land together
 * each miss the other's uncommitted row: both commit, neither makes the match,
 * and the pair can never swipe on each other again to get one. And a rewind
 * could delete a like in the instant the other person was matching it.
 *
 * An advisory lock rather than a row lock, because there is no row to lock
 * until the match exists. Keyed on the ordered pair and the mode, so swipes
 * between other people never wait for it; transaction-scoped, so commit or
 * rollback always releases it. Taking it twice in one transaction is harmless.
 */
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

/**
 * Creates a match when the target has already liked the actor IN THE SAME MODE.
 *
 * Runs inside the caller's transaction so a match and the swipe that caused it
 * commit together.
 *
 * Returns null when there is no reciprocal like — the ordinary case.
 */
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

  // Either side has paused new matches (DECISIONS.md, 24 Sep 2026). The like
  // stands and the pair waits: `matchLikesHeldByPause` makes the match the
  // moment the pause ends. Checked here, where every match is made, so no
  // path to a match can forget it.
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
