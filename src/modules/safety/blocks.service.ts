import { MatchStatus, type Prisma, prisma } from '@/db/prisma';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { ApiError } from '@utils/api-error';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';

/**
 * Blocking (spec §5.5, Batch 12).
 *
 * The EXCLUSION side of blocking — what a block hides — lives in
 * `block.service.ts` and is composed into every query that can surface a user.
 * This file is only the CRUD: creating, removing, and listing them.
 *
 * They are deliberately separate. The exclusion clause is imported by a dozen
 * modules and must never grow a dependency on report handling or photo
 * presigning; this file imports both.
 */

/**
 * Creates a block inside the caller's transaction.
 *
 * Takes a transaction client because reporting-with-block has to be atomic
 * (spec §5.7): a report filed without its block, because a write failed in
 * between, leaves someone still exposed to the person they just reported.
 *
 * Idempotent — blocking twice is not an error. The user pressed the button
 * again, which is not a state worth an error message.
 */
export async function blockUser(
  tx: Prisma.TransactionClient,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await tx.block.upsert({
    where: { blocker_id_blocked_id: { blocker_id: blockerId, blocked_id: blockedId } },
    create: { blocker_id: blockerId, blocked_id: blockedId },
    update: {},
  });
}

export interface BlockView {
  id: string;
  blocked_at: string;
  user: UserCompact;
}

/**
 * Blocks someone and severs the relationship.
 *
 * The block alone would hide them from decks and profile views, but an active
 * match would still sit in both people's lists — visible and frozen, which is
 * right for a match that lapsed and wrong for one the user deliberately cut.
 * Unmatching makes the intent stick.
 */
export async function block(blockerId: string, blockedId: string): Promise<BlockView> {
  if (blockerId === blockedId) {
    throw ApiError.validation({ user_id: ['You cannot block yourself.'] });
  }

  const target = await prisma.user.findFirst({
    where: { id: blockedId, deleted_at: null },
    select: { ...USER_COMPACT_SELECT },
  });

  if (!target) {
    throw ApiError.notFound();
  }

  const created = await prisma.$transaction(async (tx) => {
    await blockUser(tx, blockerId, blockedId);

    // Both directions: whichever way round the pair sits on the match row.
    await tx.match.updateMany({
      where: {
        status: MatchStatus.active,
        OR: [
          { user_a_id: blockerId, user_b_id: blockedId },
          { user_a_id: blockedId, user_b_id: blockerId },
        ],
      },
      data: {
        status: MatchStatus.unmatched,
        unmatched_at: new Date(),
        unmatched_by_id: blockerId,
      },
    });

    return tx.block.findUniqueOrThrow({
      where: { blocker_id_blocked_id: { blocker_id: blockerId, blocked_id: blockedId } },
    });
  });

  logger.info({ blocker_id: blockerId }, 'user blocked');

  const photoUrls = await getPrimaryPhotoUrlsFor([blockedId]);

  return {
    id: created.id,
    blocked_at: created.created_at.toISOString(),
    user: toUserCompact(target, photoUrls.get(blockedId) ?? null),
  };
}

/**
 * Removes a block. Does NOT restore the match it severed.
 *
 * Unblocking means "I am willing to see this person again", not "undo
 * everything". Resurrecting a match the user deliberately cut would be a
 * surprise, and the pair can simply match again.
 */
export async function unblock(blockerId: string, blockedId: string): Promise<void> {
  const deleted = await prisma.block.deleteMany({
    where: { blocker_id: blockerId, blocked_id: blockedId },
  });

  if (deleted.count === 0) {
    throw ApiError.notFound('That person is not blocked.');
  }

  logger.info({ blocker_id: blockerId }, 'user unblocked');
}

/**
 * The blocks this user created.
 *
 * Only their own. Listing who has blocked YOU would tell someone exactly that,
 * which is the one thing the whole 404-not-403 rule exists to prevent.
 */
export async function listBlocks(blockerId: string, options: { limit: number; cursor?: string }) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.block.findMany({
    where: {
      blocker_id: blockerId,
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
    include: { blocked: { select: USER_COMPACT_SELECT } },
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  const photoUrls = await getPrimaryPhotoUrlsFor(page.items.map((row) => row.blocked.id));

  return {
    blocks: page.items.map((row) => ({
      id: row.id,
      blocked_at: row.created_at.toISOString(),
      user: toUserCompact(row.blocked, photoUrls.get(row.blocked.id) ?? null),
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}
