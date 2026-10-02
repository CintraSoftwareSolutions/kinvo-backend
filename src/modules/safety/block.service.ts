import { type Prisma, UserStatus, prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';

export async function getBlockedUserIds(viewerId: string): Promise<string[]> {
  const blocks = await prisma.block.findMany({
    where: {
      OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }],
    },
    select: { blocker_id: true, blocked_id: true },
  });

  const ids = new Set<string>();
  for (const block of blocks) {
    ids.add(block.blocker_id === viewerId ? block.blocked_id : block.blocker_id);
  }

  return [...ids];
}

export interface VisibilityOptions {
  includeSelf?: boolean;
  includeSnoozed?: boolean;
}

export function visibleUserFilter(
  viewerId: string,
  blockedUserIds: string[],
  options: VisibilityOptions = {},
): Prisma.UserWhereInput {
  const excludedIds = options.includeSelf ? blockedUserIds : [...blockedUserIds, viewerId];

  const filter: Prisma.UserWhereInput = {
    // Soft-deleted users are gone from every read path.
    deleted_at: null,
    // A suspended or still-pending account is not shown to anyone.
    status: UserStatus.active,
  };

  if (excludedIds.length > 0) {
    filter.id = { notIn: excludedIds };
  }

  if (!options.includeSnoozed) {
    filter.is_snoozed = false;
  }

  return filter;
}

export async function assertVisible(
  viewerId: string,
  targetUserId: string,
  options: VisibilityOptions = {},
): Promise<void> {
  if (viewerId === targetUserId) {
    return;
  }

  const blockedUserIds = await getBlockedUserIds(viewerId);

  const target = await prisma.user.findFirst({
    where: {
      AND: [
        { id: targetUserId },
        visibleUserFilter(viewerId, blockedUserIds, { ...options, includeSelf: true }),
      ],
    },
    select: { id: true },
  });

  if (!target) {
    throw ApiError.notFound();
  }
}

export async function isBlockedBetween(userIdA: string, userIdB: string): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blocker_id: userIdA, blocked_id: userIdB },
        { blocker_id: userIdB, blocked_id: userIdA },
      ],
    },
    select: { id: true },
  });

  return block !== null;
}
