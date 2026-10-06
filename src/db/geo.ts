import { Prisma, prisma } from '@/db/prisma';

export const SRID = 4326;

export interface Coordinates {
  longitude: number;
  latitude: number;
}

export interface NearbyProfile {
  user_id: string;
  profile_id: string;
  distance_metres: number;
}

export interface NearbyVenue {
  venue_id: string;
  distance_metres: number;
}

function assertValidCoordinates({ longitude, latitude }: Coordinates): void {
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`longitude out of range: ${longitude}`);
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`latitude out of range: ${latitude}`);
  }
}

function point({ longitude, latitude }: Coordinates): Prisma.Sql {
  return Prisma.sql`ST_SetSRID(ST_MakePoint(${longitude}::double precision, ${latitude}::double precision), ${SRID})::geography`;
}

// ---------------------------------------------------------------------------
// Writing locations
// ---------------------------------------------------------------------------

export async function setProfileLocation(
  profileId: string,
  coordinates: Coordinates,
): Promise<void> {
  assertValidCoordinates(coordinates);

  await prisma.$executeRaw`
    UPDATE profiles
    SET location = ${point(coordinates)},
        location_updated_at = NOW()
    WHERE id = ${profileId}::uuid
  `;
}

export async function setVenueLocation(venueId: string, coordinates: Coordinates): Promise<void> {
  assertValidCoordinates(coordinates);

  await prisma.$executeRaw`
    UPDATE venues
    SET location = ${point(coordinates)}
    WHERE id = ${venueId}::uuid
  `;
}

/**
 * The same write, inside a caller's transaction.
 *
 * Creating a venue is two statements — Prisma inserts the row, and only raw SQL
 * can set the `geography` column — and they MUST commit together. A venue that
 * exists with no location is not a partial success: it can never appear in a
 * radius query, so it is invisible in the app while looking complete in the
 * admin panel, which is the kind of bug that gets found months later by a user.
 *
 * Takes the transaction client rather than the module-level one; passing the
 * latter here would silently run outside the transaction and defeat the point.
 */
export async function setVenueLocationTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  coordinates: Coordinates,
): Promise<void> {
  assertValidCoordinates(coordinates);

  await tx.$executeRaw`
    UPDATE venues
    SET location = ${point(coordinates)}
    WHERE id = ${venueId}::uuid
  `;
}

export interface SourcedVenue {
  externalId: string;
  name: string;
  category: string;
  modes: string[];
  coordinates: Coordinates;
  address: string | null;
  city: string | null;
  country: string | null;
  websiteUrl: string | null;
  phone: string | null;
}

// A refresh updates what the provider describes and leaves what an admin
// decides alone: category, modes and whether the venue is listed at all.
//
// `is_reviewed` is inserted FALSE, against the column's default of true. The
// default exists for the seeded venues, which are reviewed by definition; a row
// a places provider returned is the exact opposite — nobody has looked at it,
// and taking the default would quietly file every imported venue as already
// approved and empty the admin review queue of the only rows that belong in it.
// It is absent from the DO UPDATE clause for the same reason the rest of the
// admin fields are: a refresh must never undo a decision somebody made.
export async function upsertSourcedVenues(source: string, venues: SourcedVenue[]): Promise<void> {
  if (venues.length === 0) {
    return;
  }

  venues.forEach((venue) => assertValidCoordinates(venue.coordinates));

  await prisma.$transaction(
    venues.map(
      (venue) => prisma.$executeRaw`
        INSERT INTO venues (id, name, category, modes, location, address, city, country,
                            website_url, phone, source, external_id, is_active, is_reviewed,
                            created_at, updated_at)
        VALUES (gen_random_uuid(), ${venue.name}, ${venue.category}::venue_category,
                ${venue.modes}::mode[], ${point(venue.coordinates)}, ${venue.address},
                ${venue.city}, ${venue.country}, ${venue.websiteUrl}, ${venue.phone},
                ${source}::venue_source, ${venue.externalId}, true, false, NOW(), NOW())
        ON CONFLICT (source, external_id) DO UPDATE
        SET name = EXCLUDED.name,
            location = EXCLUDED.location,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            country = EXCLUDED.country,
            website_url = EXCLUDED.website_url,
            phone = EXCLUDED.phone,
            updated_at = NOW()
      `,
    ),
  );
}

export async function clearProfileLocation(profileId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE profiles
    SET location = NULL, location_updated_at = NULL
    WHERE id = ${profileId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// Reading locations
// ---------------------------------------------------------------------------

export async function getProfileCoordinates(profileId: string): Promise<Coordinates | null> {
  const rows = await prisma.$queryRaw<{ longitude: number; latitude: number }[]>`
    SELECT ST_X(location::geometry) AS longitude,
           ST_Y(location::geometry) AS latitude
    FROM profiles
    WHERE id = ${profileId}::uuid AND location IS NOT NULL
  `;

  return rows[0] ?? null;
}

export async function distanceBetweenProfiles(
  profileIdA: string,
  profileIdB: string,
): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ distance_metres: number }[]>`
    SELECT ST_Distance(a.location, b.location) AS distance_metres
    FROM profiles a, profiles b
    WHERE a.id = ${profileIdA}::uuid
      AND b.id = ${profileIdB}::uuid
      AND a.location IS NOT NULL
      AND b.location IS NOT NULL
  `;

  const row = rows[0];
  return row ? Math.round(row.distance_metres) : null;
}

// ---------------------------------------------------------------------------
// Radius search
// ---------------------------------------------------------------------------

export async function findProfilesWithinRadius(
  centre: Coordinates,
  radiusMetres: number,
  options: { limit?: number; excludeUserIds?: string[] } = {},
): Promise<NearbyProfile[]> {
  assertValidCoordinates(centre);

  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) {
    throw new RangeError(`radiusMetres must be positive: ${radiusMetres}`);
  }

  const limit = options.limit ?? 100;
  const excluded = options.excludeUserIds ?? [];

  const exclusion =
    excluded.length > 0 ? Prisma.sql`AND p.user_id <> ALL(${excluded}::uuid[])` : Prisma.empty;

  const origin = point(centre);

  return prisma.$queryRaw<NearbyProfile[]>`
    SELECT p.user_id,
           p.id AS profile_id,
           ROUND(ST_Distance(p.location, ${origin}))::int AS distance_metres
    FROM profiles p
    WHERE p.location IS NOT NULL
      AND ST_DWithin(p.location, ${origin}, ${radiusMetres}::double precision)
      ${exclusion}
    ORDER BY p.location <-> ${origin}
    LIMIT ${limit}
  `;
}
export async function findVenuesWithinRadius(
  centre: Coordinates,
  radiusMetres: number,
  options: { limit?: number; category?: string } = {},
): Promise<NearbyVenue[]> {
  assertValidCoordinates(centre);

  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) {
    throw new RangeError(`radiusMetres must be positive: ${radiusMetres}`);
  }

  const limit = options.limit ?? 50;
  const origin = point(centre);

  const categoryFilter = options.category
    ? Prisma.sql`AND v.category = ${options.category}::venue_category`
    : Prisma.empty;

  return prisma.$queryRaw<NearbyVenue[]>`
    SELECT v.id AS venue_id,
           ROUND(ST_Distance(v.location, ${origin}))::int AS distance_metres
    FROM venues v
    WHERE v.location IS NOT NULL
      AND v.is_active = true
      AND ST_DWithin(v.location, ${origin}, ${radiusMetres}::double precision)
      ${categoryFilter}
    ORDER BY v.location <-> ${origin}
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Live location (spec §5.7, Batch 12)
// ---------------------------------------------------------------------------

export async function recordLocationPing(
  sessionId: string,
  coordinates: Coordinates,
  accuracyMetres?: number,
): Promise<void> {
  assertValidCoordinates(coordinates);

  await prisma.$executeRaw`
    INSERT INTO live_location_pings (id, session_id, location, accuracy_metres, recorded_at)
    VALUES (
      gen_random_uuid(),
      ${sessionId}::uuid,
      ${point(coordinates)},
      ${accuracyMetres ?? null}::int,
      NOW()
    )
  `;
}

export interface LocationPing {
  latitude: number;
  longitude: number;
  accuracy_metres: number | null;
  recorded_at: Date;
}

export async function readLocationPings(sessionId: string, limit = 50): Promise<LocationPing[]> {
  return prisma.$queryRaw<LocationPing[]>`
    SELECT ST_Y(location::geometry) AS latitude,
           ST_X(location::geometry) AS longitude,
           accuracy_metres,
           recorded_at
    FROM live_location_pings
    WHERE session_id = ${sessionId}::uuid
      AND location IS NOT NULL
    ORDER BY recorded_at DESC
    LIMIT ${limit}
  `;
}

export async function pruneExpiredLiveLocations(now: Date = new Date()): Promise<number> {
  const result = await prisma.$executeRaw`
    DELETE FROM live_location_pings
    WHERE session_id IN (
      SELECT id FROM live_location_sessions
      WHERE ended_at IS NOT NULL OR expires_at <= ${now}
    )
  `;

  return result;
}

export async function setEmergencyLocation(
  eventId: string,
  coordinates: Coordinates,
): Promise<void> {
  assertValidCoordinates(coordinates);

  await prisma.$executeRaw`
    UPDATE emergency_events
    SET location = ${point(coordinates)}
    WHERE id = ${eventId}::uuid
  `;
}

export async function getEmergencyLocation(eventId: string): Promise<Coordinates | null> {
  const rows = await prisma.$queryRaw<{ longitude: number; latitude: number }[]>`
    SELECT ST_X(location::geometry) AS longitude,
           ST_Y(location::geometry) AS latitude
    FROM emergency_events
    WHERE id = ${eventId}::uuid AND location IS NOT NULL
  `;

  return rows[0] ?? null;
}
