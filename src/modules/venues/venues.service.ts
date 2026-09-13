import { MatchStatus, type Mode, type VenueCategory, prisma } from '@/db/prisma';
import { type Coordinates, findVenuesWithinRadius, getProfileCoordinates } from '@/db/geo';
import { ApiError } from '@utils/api-error';

/**
 * Venues (spec §5.9, Batch 12).
 *
 * Admin-curated, not user-generated: the list is a safety surface as much as a
 * convenience one, because it is where the product suggests two strangers meet.
 * Creating and editing venues belongs to the admin module in Batch 15.
 */

const DEFAULT_RADIUS_METRES = 10_000;
const MAX_RADIUS_METRES = 50_000;

export interface VenueView {
  id: string;
  name: string;
  category: VenueCategory;
  description: string | null;
  address: string | null;
  city: string | null;
  rating: number | null;
  price_level: number | null;
  photo_url: string | null;
  website_url: string | null;
  modes: Mode[];
  /** spec §4.6: metres. The client formats to miles. */
  distance_metres: number | null;
  is_saved: boolean;
}

interface VenueRow {
  id: string;
  name: string;
  category: VenueCategory;
  description: string | null;
  address: string | null;
  city: string | null;
  rating: number | null;
  price_level: number | null;
  photo_url: string | null;
  website_url: string | null;
  modes: Mode[];
}

function toView(venue: VenueRow, distanceMetres: number | null, savedIds: Set<string>): VenueView {
  return {
    id: venue.id,
    name: venue.name,
    category: venue.category,
    description: venue.description,
    address: venue.address,
    city: venue.city,
    rating: venue.rating,
    price_level: venue.price_level,
    photo_url: venue.photo_url,
    website_url: venue.website_url,
    modes: venue.modes,
    distance_metres: distanceMetres,
    is_saved: savedIds.has(venue.id),
  };
}

const VENUE_SELECT = {
  id: true,
  name: true,
  category: true,
  description: true,
  address: true,
  city: true,
  rating: true,
  price_level: true,
  photo_url: true,
  website_url: true,
  modes: true,
} as const;

async function savedVenueIds(userId: string, venueIds: string[]): Promise<Set<string>> {
  if (venueIds.length === 0) {
    return new Set();
  }

  const saved = await prisma.savedVenue.findMany({
    where: { user_id: userId, venue_id: { in: venueIds } },
    select: { venue_id: true },
  });

  return new Set(saved.map((row) => row.venue_id));
}

export interface SearchVenuesOptions {
  category?: VenueCategory;
  mode?: Mode;
  radius_metres?: number;
  limit?: number;
  /** Overrides the caller's profile location, for browsing another area. */
  latitude?: number;
  longitude?: number;
}

/**
 * Nearby venues, nearest first (spec §5.9).
 *
 * Distance sorting comes from PostGIS; category and mode filtering happen in
 * Prisma on the result. Splitting it that way keeps the spatial query in
 * `geo.ts` free of business filters, which is the rule that has kept spatial
 * SQL in one file for twelve batches.
 */
export async function searchVenues(
  userId: string,
  options: SearchVenuesOptions,
): Promise<VenueView[]> {
  const centre = await resolveCentre(userId, options);
  const radius = Math.min(options.radius_metres ?? DEFAULT_RADIUS_METRES, MAX_RADIUS_METRES);
  const limit = Math.min(options.limit ?? 20, 50);

  // A generous spatial limit, because category and mode filters run afterwards
  // and a tight one would return three cafes in a city full of them.
  const nearby = await findVenuesWithinRadius(centre, radius, { limit: 200 });

  if (nearby.length === 0) {
    return [];
  }

  const distanceById = new Map(nearby.map((row) => [row.venue_id, row.distance_metres]));

  const venues = await prisma.venue.findMany({
    where: {
      id: { in: nearby.map((row) => row.venue_id) },
      is_active: true,
      ...(options.category ? { category: options.category } : {}),
      // spec §5.9: suggestions are tuned to the mode. `has` matches the array
      // column, so a venue tagged for study_buddy does not surface in cuddle.
      ...(options.mode ? { modes: { has: options.mode } } : {}),
    },
    select: VENUE_SELECT,
  });

  const saved = await savedVenueIds(
    userId,
    venues.map((venue) => venue.id),
  );

  return venues
    .map((venue) => toView(venue, distanceById.get(venue.id) ?? null, saved))
    .sort((a, b) => (a.distance_metres ?? Infinity) - (b.distance_metres ?? Infinity))
    .slice(0, limit);
}

async function resolveCentre(userId: string, options: SearchVenuesOptions): Promise<Coordinates> {
  if (options.latitude !== undefined && options.longitude !== undefined) {
    return { latitude: options.latitude, longitude: options.longitude };
  }

  const profile = await prisma.profile.findUnique({
    where: { user_id: userId },
    select: { id: true },
  });

  const centre = profile ? await getProfileCoordinates(profile.id) : null;

  if (!centre) {
    throw ApiError.badRequest('Set your location, or search around a point.', {
      requires_location: true,
    });
  }

  return centre;
}

export async function getVenue(userId: string, venueId: string): Promise<VenueView> {
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, is_active: true },
    select: VENUE_SELECT,
  });

  if (!venue) {
    throw ApiError.notFound();
  }

  const saved = await savedVenueIds(userId, [venueId]);

  return toView(venue, null, saved);
}

/** "Save for later" — a per-user list (spec §5.9). Idempotent. */
export async function saveVenue(userId: string, venueId: string): Promise<void> {
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, is_active: true },
    select: { id: true },
  });

  if (!venue) {
    throw ApiError.notFound();
  }

  await prisma.savedVenue.upsert({
    where: { user_id_venue_id: { user_id: userId, venue_id: venueId } },
    create: { user_id: userId, venue_id: venueId },
    update: {},
  });
}

export async function unsaveVenue(userId: string, venueId: string): Promise<void> {
  const deleted = await prisma.savedVenue.deleteMany({
    where: { user_id: userId, venue_id: venueId },
  });

  if (deleted.count === 0) {
    throw ApiError.notFound('That venue is not saved.');
  }
}

export async function listSavedVenues(userId: string): Promise<VenueView[]> {
  const saved = await prisma.savedVenue.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    include: { venue: { select: VENUE_SELECT } },
  });

  const ids = new Set(saved.map((row) => row.venue_id));

  return saved.map((row) => toView(row.venue, null, ids));
}

/**
 * Venues to suggest to a match, tuned to the mode they share (spec §5.9).
 *
 * Centred on the CALLER's location rather than a midpoint. A midpoint sounds
 * fairer but requires reading the other person's coordinates to compute, and
 * exposing where someone lives — even indirectly, through which venues appear —
 * is not worth the convenience.
 */
export async function suggestForMatch(
  userId: string,
  matchId: string,
  limit = 10,
): Promise<VenueView[]> {
  const match = await prisma.match.findFirst({
    where: {
      id: matchId,
      status: MatchStatus.active,
      OR: [{ user_a_id: userId }, { user_b_id: userId }],
    },
    select: { mode: true },
  });

  if (!match) {
    throw ApiError.notFound();
  }

  return searchVenues(userId, { mode: match.mode, limit });
}

export { DEFAULT_RADIUS_METRES, MAX_RADIUS_METRES };
