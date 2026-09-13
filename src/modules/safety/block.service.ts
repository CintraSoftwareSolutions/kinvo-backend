import { type Prisma, UserStatus, prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';

/**
 * Blocks beat everything (spec §5.5).
 *
 * This module exists so the block rule is written ONCE. The spec is explicit
 * that it must be "a single shared exclusion clause used by every query, not
 * re-implemented per endpoint" — it calls this the most commonly leaked rule in
 * dating apps.
 *
 * Every query that can surface another user must compose `visibleUserFilter`,
 * and every endpoint that takes a target user id must call `assertVisible`.
 * Batch 12 adds the block and unblock endpoints on top of this; the enforcement
 * lives here from the moment the first endpoint could leak.
 *
 * The block endpoints themselves do not exist yet, so today this reads an empty
 * table — which is exactly the point. The clause is in place and tested before
 * there is anything to leak.
 */

/**
 * Everyone the viewer cannot see because of a block, in either direction.
 *
 * Both directions matter: A blocking B hides B from A *and* A from B. Checking
 * only one side is the classic half-implementation.
 */
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
  /** Include the viewer themselves. False for decks, true for "can I see this profile". */
  includeSelf?: boolean;
  /** Snoozed users stay out of decks but remain reachable in existing matches (spec §5.6). */
  includeSnoozed?: boolean;
}

/**
 * The shared exclusion clause.
 *
 * Compose this into the `where` of any query that can surface another user.
 * Callers add their own conditions with AND; they must never rebuild these.
 */
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

/**
 * Resolves a target user for a viewer, or throws 404.
 *
 * spec §4.4: return 404, not 403, when a block is the reason. A 403 confirms
 * the resource exists, which leaks who blocked whom. "Blocked", "suspended",
 * "deleted", and "never existed" must be indistinguishable from outside.
 */
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

/** True when a block exists in either direction. */
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
