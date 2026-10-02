import { MatchStatus, type Prisma, prisma } from '@/db/prisma';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { closePlansOnEndedMatches } from '@modules/plans/ended-matches';
import { ApiError } from '@utils/api-error';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';

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

  // Both directions: whichever way round the pair sits on the match row.
  const pair: Prisma.MatchWhereInput = {
    OR: [
      { user_a_id: blockerId, user_b_id: blockedId },
      { user_a_id: blockedId, user_b_id: blockerId },
    ],
  };

  await tx.match.updateMany({
    where: { status: MatchStatus.active, ...pair },
    data: {
      status: MatchStatus.unmatched,
      unmatched_at: new Date(),
      unmatched_by_id: blockerId,
    },
  });

  await closePlansOnEndedMatches(tx, pair, blockerId);
}

export interface BlockView {
  id: string;
  blocked_at: string;
  user: UserCompact;
}

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

export async function unblock(blockerId: string, blockedId: string): Promise<void> {
  const deleted = await prisma.block.deleteMany({
    where: { blocker_id: blockerId, blocked_id: blockedId },
  });

  if (deleted.count === 0) {
    throw ApiError.notFound('That person is not blocked.');
  }

  logger.info({ blocker_id: blockerId }, 'user unblocked');
}

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
