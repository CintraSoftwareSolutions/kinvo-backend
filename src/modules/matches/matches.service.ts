import { DISCOVERY } from '@config/constants';
import { MatchStatus, type Mode, type Prisma, UserStatus, prisma } from '@/db/prisma';
import { requireFeature } from '@modules/entitlements/entitlements.service';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { closePlansOnEndedMatches } from '@modules/plans/ended-matches';
import { getBlockedUserIds, isBlockedBetween } from '@modules/safety/block.service';
import { onlineStatusFor } from '@/realtime/presence';
import { ApiError } from '@utils/api-error';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';

export interface MatchView {
  id: string;
  mode: Mode;
  status: MatchStatus;
  is_super_like: boolean;
  matched_at: string;
  expires_at: string;
  is_expired: boolean;
  extension_count: number;
  is_writable: boolean;
  user: UserCompact;
  conversation_id: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
}

export function isExpired(match: { status: MatchStatus; expires_at: Date }, now = new Date()) {
  return match.status === MatchStatus.expired || match.expires_at <= now;
}

export function otherUserId(
  match: { user_a_id: string; user_b_id: string },
  viewerId: string,
): string {
  return match.user_a_id === viewerId ? match.user_b_id : match.user_a_id;
}

export async function isPairReachable(
  match: { status: MatchStatus; expires_at: Date },
  viewerId: string,
  other: { id: string; deleted_at: Date | null; status: UserStatus },
): Promise<boolean> {
  return (
    match.status === MatchStatus.active &&
    !isExpired(match) &&
    other.deleted_at === null &&
    other.status === UserStatus.active &&
    !(await isBlockedBetween(viewerId, other.id))
  );
}

export function isMatchListed(
  match: { status: MatchStatus },
  other: { deleted_at: Date | null; status: UserStatus },
): boolean {
  return (
    match.status !== MatchStatus.unmatched &&
    other.deleted_at === null &&
    other.status === UserStatus.active
  );
}

const PARTICIPANT_SELECT = {
  ...USER_COMPACT_SELECT,
  deleted_at: true,
  status: true,
} as const;

const MATCH_INCLUDE = {
  user_a: { select: PARTICIPANT_SELECT },
  user_b: { select: PARTICIPANT_SELECT },
  conversation: {
    select: {
      id: true,
      last_message_at: true,
      last_message_preview: true,
      states: { select: { user_id: true, unread_count: true, is_archived: true } },
    },
  },
} satisfies Prisma.MatchInclude;

type MatchWithRelations = Prisma.MatchGetPayload<{ include: typeof MATCH_INCLUDE }>;

function toMatchView(
  match: MatchWithRelations,
  viewerId: string,
  photoUrls: Map<string, string>,
  blockedUserIds: Set<string>,
  online: Set<string>,
  now = new Date(),
): MatchView {
  const other = match.user_a_id === viewerId ? match.user_b : match.user_a;
  const state = match.conversation?.states.find((row) => row.user_id === viewerId);
  const expired = isExpired(match, now);

  return {
    id: match.id,
    mode: match.mode,
    status: match.status,
    is_super_like: match.is_super_like,
    matched_at: match.matched_at.toISOString(),
    expires_at: match.expires_at.toISOString(),
    is_expired: expired,
    extension_count: match.extension_count,
    is_writable: !expired && match.status === MatchStatus.active && !blockedUserIds.has(other.id),
    user: toUserCompact(other, photoUrls.get(other.id) ?? null, online.has(other.id)),
    conversation_id: match.conversation?.id ?? null,
    last_message_at: match.conversation?.last_message_at?.toISOString() ?? null,
    last_message_preview: match.conversation?.last_message_preview ?? null,
    unread_count: state?.unread_count ?? 0,
  };
}

export interface ListMatchesOptions {
  limit: number;
  cursor?: string;
  mode?: Mode;
  archived?: boolean;
}

export async function listMatches(viewerId: string, options: ListMatchesOptions) {
  const blockedUserIds = await getBlockedUserIds(viewerId);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const archived = options.archived ?? false;

  const rows = await prisma.match.findMany({
    where: {
      OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
      // An unmatch is final for both sides and the row stops being a match.
      status: { not: MatchStatus.unmatched },
      ...(options.mode ? { mode: options.mode } : {}),
      conversation: { states: { some: { user_id: viewerId, is_archived: archived } } },
      ...(after ? { matched_at: { lt: new Date(String(after.k)) } } : {}),
    },
    include: MATCH_INCLUDE,
    orderBy: { matched_at: 'desc' },
    take: options.limit + 1,
  });

  // Applied in memory rather than in the where clause: `visibleUserFilter`
  // shapes a User query and a match has two of them, so composing it here
  // would need a nested OR per side. The set is one page, never a table scan.
  const visible = rows.filter((match) =>
    isMatchListed(match, match.user_a_id === viewerId ? match.user_b : match.user_a),
  );

  const page = paginate(visible, options.limit, (match) => ({
    k: match.matched_at.toISOString(),
    id: match.id,
  }));

  const otherIds = page.items.map((match) => otherUserId(match, viewerId));

  // Both resolved in bulk, one round trip each, rather than per row.
  const [photoUrls, online] = await Promise.all([
    getPrimaryPhotoUrlsFor(otherIds),
    onlineStatusFor(otherIds),
  ]);

  const now = new Date();
  const blocked = new Set(blockedUserIds);

  return {
    matches: page.items.map((match) =>
      toMatchView(match, viewerId, photoUrls, blocked, online, now),
    ),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export async function getMatch(viewerId: string, matchId: string): Promise<MatchView> {
  const match = await prisma.match.findFirst({
    where: {
      id: matchId,
      OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
      status: { not: MatchStatus.unmatched },
    },
    include: MATCH_INCLUDE,
  });

  if (!match) {
    throw ApiError.notFound();
  }

  const other = match.user_a_id === viewerId ? match.user_b : match.user_a;

  if (!isMatchListed(match, other)) {
    throw ApiError.notFound();
  }

  const [photoUrls, blockedUserIds, online] = await Promise.all([
    getPrimaryPhotoUrlsFor([other.id]),
    getBlockedUserIds(viewerId),
    onlineStatusFor([other.id]),
  ]);

  return toMatchView(match, viewerId, photoUrls, new Set(blockedUserIds), online);
}

export async function unmatch(viewerId: string, matchId: string): Promise<void> {
  const match = await prisma.match.findFirst({
    where: {
      id: matchId,
      OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
      status: { not: MatchStatus.unmatched },
    },
    select: { id: true },
  });

  if (!match) {
    throw ApiError.notFound();
  }

  await prisma.$transaction(async (tx) => {
    await tx.match.update({
      where: { id: match.id },
      data: {
        status: MatchStatus.unmatched,
        unmatched_at: new Date(),
        unmatched_by_id: viewerId,
      },
    });

    await closePlansOnEndedMatches(tx, { id: match.id }, viewerId);
  });

  logger.info({ match_id: match.id }, 'match unmatched');
}

export async function extendMatch(viewerId: string, matchId: string): Promise<MatchView> {
  await requireFeature(
    viewerId,
    ENTITLEMENT_KEYS.EXTEND_MATCHES,
    'Extending a match is available with Premium.',
  );

  const match = await prisma.match.findFirst({
    where: {
      id: matchId,
      OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
      status: { not: MatchStatus.unmatched },
    },
    select: { id: true, expires_at: true, status: true },
  });

  if (!match) {
    throw ApiError.notFound();
  }

  const now = new Date();
  const from = match.expires_at > now ? match.expires_at : now;
  const extended = new Date(from.getTime() + DISCOVERY.MATCH_EXTENSION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.match.update({
    where: { id: match.id },
    data: {
      expires_at: extended,
      extended_at: now,
      extension_count: { increment: 1 },
      // An expired match that is extended is live again.
      status: MatchStatus.active,
    },
  });

  return getMatch(viewerId, match.id);
}

export async function sweepExpiredMatches(now = new Date()): Promise<number> {
  const result = await prisma.match.updateMany({
    where: { status: MatchStatus.active, expires_at: { lte: now } },
    data: { status: MatchStatus.expired },
  });

  if (result.count > 0) {
    logger.info({ count: result.count }, 'matches expired');
  }

  return result.count;
}
