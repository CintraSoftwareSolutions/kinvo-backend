import { DISCOVERY } from '@config/constants';
import { type Mode, type Prisma, type UserModeModel, prisma } from '@/db/prisma';
import { findProfilesWithinRadius, getProfileCoordinates } from '@/db/geo';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { getBlockedUserIds, visibleUserFilter } from '@modules/safety/block.service';
import { ApiError } from '@utils/api-error';
import { dateOfBirthRangeForAges } from '@utils/age';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { type CursorPayload, decodeCursor, paginate } from '@utils/cursor';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';

/**
 * Deck generation (spec §5.3, Batch 7).
 *
 * Decks are precomputed per user, per mode, per day. Two reasons, both
 * load-bearing:
 *
 *  1. Pagination is stable. Re-running a ranking algorithm on every scroll
 *     means a card can move between pages and be seen twice or never.
 *  2. The algorithm runs once a day per user instead of once per scroll.
 *
 * EVERY filter below is mode-scoped. The same person may be an excellent
 * study-buddy candidate and someone this user already passed on in dating, and
 * those two facts must never leak into each other.
 */

export interface DeckCard {
  entry_id: string;
  position: number;
  /** spec §4.6: metres. The client formats to miles. */
  distance_metres: number | null;
  user: UserCompact;
  bio: string | null;
  interests: string[];
}

/** The viewer's mode row, or a clear error. Shared with the swipe service. */
export async function requireEnabledMode(userId: string, mode: Mode): Promise<UserModeModel> {
  const userMode = await prisma.userMode.findUnique({
    where: { user_id_mode: { user_id: userId, mode } },
  });

  if (!userMode || !userMode.is_enabled) {
    // Not 404: the mode plainly exists and the app knows it. This is the user
    // needing to turn it on, which is an action they can take.
    throw new ApiError(
      ERROR_CODES.BAD_REQUEST,
      'Turn this mode on before browsing it.',
      { mode, is_enabled: false },
      400,
    );
  }

  return userMode;
}

/**
 * Ranking (spec §5.3).
 *
 * Pure so it can be unit-tested without a database, and so the weighting is
 * legible in one place rather than buried in an ORDER BY.
 *
 * Ranking is NOT filtering. A verified badge or an active boost moves someone
 * up the deck; neither can put someone into a deck they were excluded from.
 * Conflating the two is how a boost would start bypassing a block.
 */
export function scoreCandidate(input: {
  isVerified: boolean;
  isBoosted: boolean;
  lastActiveAt: Date;
  distanceMetres: number | null;
  radiusMetres: number;
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  let score = 0;

  if (input.isVerified) {
    score += DISCOVERY.VERIFIED_SCORE_BONUS;
  }

  if (input.isBoosted) {
    score += DISCOVERY.BOOST_SCORE_BONUS;
  }

  const hoursSinceActive = (now.getTime() - input.lastActiveAt.getTime()) / (60 * 60 * 1000);
  const recency = Math.max(0, 1 - hoursSinceActive / DISCOVERY.RECENCY_WINDOW_HOURS);
  score += recency * DISCOVERY.RECENCY_SCORE_MAX;

  if (input.distanceMetres !== null && input.radiusMetres > 0) {
    const proximity = Math.max(0, 1 - input.distanceMetres / input.radiusMetres);
    score += proximity * DISCOVERY.PROXIMITY_SCORE_MAX;
  }

  return Math.round(score * 100) / 100;
}

/** UTC date, because deck days and quota days must roll over together. */
export function deckDateFor(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Builds and persists one day's deck.
 *
 * Idempotent per (user, mode, day): calling it again replaces the entries that
 * have not been swiped yet and leaves consumed ones alone, so a regeneration
 * cannot resurrect a card the user already acted on.
 */
export async function generateDeck(userId: string, mode: Mode, now: Date = new Date()) {
  const userMode = await requireEnabledMode(userId, mode);

  const profile = await prisma.profile.findUnique({
    where: { user_id: userId },
    select: { id: true },
  });

  if (!profile) {
    throw ApiError.notFound();
  }

  const centre = await getProfileCoordinates(profile.id);

  if (!centre) {
    // Onboarding requires a location, so this is a safety net rather than an
    // expected path. Without a centre there is no radius and no distance, and
    // silently returning everyone would ignore the user's radius setting.
    throw new ApiError(
      ERROR_CODES.BAD_REQUEST,
      'Set your location before browsing.',
      { requires_location: true },
      400,
    );
  }

  const blockedUserIds = await getBlockedUserIds(userId);

  // Already-swiped IN THIS MODE. A pass in dating must not remove someone from
  // the study-buddy deck.
  const swiped = await prisma.swipe.findMany({
    where: { actor_id: userId, mode },
    select: { target_id: true },
  });

  // Cheap pre-exclusion so the spatial query returns useful rows rather than
  // spending its LIMIT on people who will be filtered out a moment later.
  const preExcluded = [...new Set([userId, ...blockedUserIds, ...swiped.map((s) => s.target_id)])];

  const nearby = await findProfilesWithinRadius(centre, userMode.radius_metres, {
    limit: DISCOVERY.CANDIDATE_POOL,
    excludeUserIds: preExcluded,
  });

  if (nearby.length === 0) {
    return persistDeck(userId, mode, now, []);
  }

  const distanceByUserId = new Map(nearby.map((row) => [row.user_id, row.distance_metres]));
  const ageWindow = dateOfBirthRangeForAges(userMode.min_age, userMode.max_age, now);

  const where: Prisma.UserWhereInput = {
    AND: [
      // THE SHARED EXCLUSION CLAUSE (spec §5.5). Never rebuild these
      // conditions here — it already covers blocked either direction, self,
      // suspended, soft-deleted, and snoozed. Adding a rule there must reach
      // the deck automatically, which is only true while this call exists.
      visibleUserFilter(userId, blockedUserIds),
      { id: { in: nearby.map((row) => row.user_id) } },
      // Mode scoping: the candidate must have THIS mode switched on. Someone
      // who never enabled `cuddle` is not a cuddle candidate.
      { user_modes: { some: { mode, is_enabled: true } } },
      // Only fully onboarded accounts are discoverable. Social and phone
      // signups have no date of birth until onboarding runs the 18+ check, and
      // an un-onboarded account must never reach a deck.
      { onboarded_at: { not: null } },
      { date_of_birth: ageWindow },
    ],
  };

  if (userMode.verified_only) {
    // The user's own hard filter — distinct from verified users ranking higher,
    // which applies to everyone's deck (spec §5.3).
    (where.AND as Prisma.UserWhereInput[]).push({ is_verified: true });
  }

  const candidates = await prisma.user.findMany({
    where,
    select: {
      ...USER_COMPACT_SELECT,
      profile: {
        select: {
          bio: true,
          interests: { select: { interest: { select: { slug: true } } } },
        },
      },
    },
    take: DISCOVERY.CANDIDATE_POOL,
  });

  const boosted = await activeBoostUserIds(
    candidates.map((c) => c.id),
    mode,
    now,
  );

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      distance: distanceByUserId.get(candidate.id) ?? null,
      score: scoreCandidate({
        isVerified: candidate.is_verified,
        isBoosted: boosted.has(candidate.id),
        lastActiveAt: candidate.last_active_at,
        distanceMetres: distanceByUserId.get(candidate.id) ?? null,
        radiusMetres: userMode.radius_metres,
        now,
      }),
    }))
    // Distance breaks ties so the order is total and deterministic — a partial
    // order would let equal-scoring rows shuffle between regenerations.
    .sort((a, b) => b.score - a.score || (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, DISCOVERY.DECK_SIZE);

  return persistDeck(
    userId,
    mode,
    now,
    ranked.map((row, index) => ({
      target_id: row.candidate.id,
      position: index,
      score: row.score,
      distance_metres: row.distance,
    })),
  );
}

async function activeBoostUserIds(userIds: string[], mode: Mode, now: Date): Promise<Set<string>> {
  if (userIds.length === 0) {
    return new Set();
  }

  const boosts = await prisma.boost.findMany({
    where: { user_id: { in: userIds }, mode, ends_at: { gt: now } },
    select: { user_id: true },
  });

  return new Set(boosts.map((boost) => boost.user_id));
}

interface EntrySeed {
  target_id: string;
  position: number;
  score: number;
  distance_metres: number | null;
}

async function persistDeck(userId: string, mode: Mode, now: Date, entries: EntrySeed[]) {
  const deckDate = deckDateFor(now);

  return prisma.$transaction(async (tx) => {
    const deck = await tx.deck.upsert({
      where: { user_id_mode_deck_date: { user_id: userId, mode, deck_date: deckDate } },
      create: { user_id: userId, mode, deck_date: deckDate },
      update: { generated_at: now },
    });

    // Unconsumed entries are replaced; consumed ones stay. Regenerating must
    // never hand back a card the user already swiped.
    await tx.deckEntry.deleteMany({ where: { deck_id: deck.id, consumed_at: null } });

    const consumed = await tx.deckEntry.findMany({
      where: { deck_id: deck.id },
      select: { target_id: true },
    });
    const alreadyPresent = new Set(consumed.map((entry) => entry.target_id));

    const fresh = entries.filter((entry) => !alreadyPresent.has(entry.target_id));

    if (fresh.length > 0) {
      await tx.deckEntry.createMany({
        data: fresh.map((entry) => ({ ...entry, deck_id: deck.id })),
      });
    }

    return { deck_id: deck.id, generated: fresh.length };
  });
}

/**
 * One page of the deck, generating today's if it does not exist yet.
 *
 * Lazy generation is what makes the BullMQ precompute an optimisation rather
 * than a dependency: if the scheduled job has not run, or is behind, the user
 * still gets a correct deck rather than an empty screen.
 */
export async function getDeck(
  userId: string,
  mode: Mode,
  options: { limit: number; cursor?: string },
): Promise<{ cards: DeckCard[]; next_cursor: string | null; has_more: boolean; limit: number }> {
  await requireEnabledMode(userId, mode);

  const deckDate = deckDateFor();

  let deck = await prisma.deck.findUnique({
    where: { user_id_mode_deck_date: { user_id: userId, mode, deck_date: deckDate } },
    select: { id: true },
  });

  if (!deck) {
    await generateDeck(userId, mode);
    deck = await prisma.deck.findUnique({
      where: { user_id_mode_deck_date: { user_id: userId, mode, deck_date: deckDate } },
      select: { id: true },
    });
  }

  if (!deck) {
    return { cards: [], next_cursor: null, has_more: false, limit: options.limit };
  }

  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.deckEntry.findMany({
    where: {
      deck_id: deck.id,
      consumed_at: null,
      ...(after ? { position: { gt: Number(after.k) } } : {}),
    },
    orderBy: { position: 'asc' },
    // One extra row so has_more is known without a second COUNT.
    take: options.limit + 1,
    select: {
      id: true,
      position: true,
      distance_metres: true,
      target: {
        select: {
          ...USER_COMPACT_SELECT,
          profile: {
            select: {
              bio: true,
              interests: { select: { interest: { select: { slug: true } } } },
            },
          },
        },
      },
    },
  });

  const page = paginate(rows, options.limit, (row) => ({ k: row.position, id: row.id }));

  // One presign pass for the whole page rather than one per card (spec §4.7).
  const photoUrls = await getPrimaryPhotoUrlsFor(page.items.map((row) => row.target.id));

  const cards: DeckCard[] = page.items.map((row) => ({
    entry_id: row.id,
    position: row.position,
    distance_metres: row.distance_metres,
    user: toUserCompact(row.target, photoUrls.get(row.target.id) ?? null),
    bio: row.target.profile?.bio ?? null,
    interests: row.target.profile?.interests.map((link) => link.interest.slug) ?? [],
  }));

  return {
    cards,
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

/** Marks the card as acted upon, so it never returns to the deck. */
export async function consumeDeckEntry(
  tx: Prisma.TransactionClient,
  userId: string,
  mode: Mode,
  targetId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.deckEntry.updateMany({
    where: {
      target_id: targetId,
      consumed_at: null,
      deck: { user_id: userId, mode },
    },
    data: { consumed_at: now },
  });
}

/** Rewind puts the card back where it was (spec §5.3). */
export async function restoreDeckEntry(
  tx: Prisma.TransactionClient,
  userId: string,
  mode: Mode,
  targetId: string,
): Promise<void> {
  await tx.deckEntry.updateMany({
    where: { target_id: targetId, deck: { user_id: userId, mode } },
    data: { consumed_at: null },
  });
}

/** Used by the nightly job; exported so the worker holds no query logic. */
export async function usersNeedingDecks(mode: Mode, limit = 1000): Promise<string[]> {
  const rows = await prisma.userMode.findMany({
    where: {
      mode,
      is_enabled: true,
      user: { deleted_at: null, status: 'active', is_snoozed: false, onboarded_at: { not: null } },
    },
    select: { user_id: true },
    take: limit,
  });

  return rows.map((row) => row.user_id);
}

export function logDeckGeneration(userId: string, mode: Mode, generated: number): void {
  logger.debug({ user_id: userId, mode, generated }, 'deck generated');
}

export type { CursorPayload };
