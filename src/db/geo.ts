import { Prisma, prisma } from '@/db/prisma';

/**
 * PostGIS access.
 *
 * Prisma cannot read or write a `geography` column — the fields are declared
 * Unsupported() in the schema — so every spatial operation lives here, in raw
 * SQL. Spec §0.5 permits raw SQL exactly for geospatial queries Prisma cannot
 * express, and confining it to one module keeps the rest of the codebase
 * free of hand-written SQL.
 *
 * Two rules for everything below:
 *
 *  1. **Coordinate order is (longitude, latitude).** `ST_MakePoint` takes X
 *     then Y, which is longitude then latitude — the reverse of how humans say
 *     it. Getting this backwards silently puts London in Antarctica.
 *  2. **Distances are metres** (spec §4.6). The `geography` type returns metres
 *     from `ST_Distance` and accepts metres in `ST_DWithin`. Never convert here;
 *     the client formats to miles.
 */

/** WGS-84, the coordinate system GPS reports in. */
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

/**
 * A `geography(Point, 4326)` literal, parameterised. Never interpolate
 * coordinates into SQL text directly.
 */
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

/**
 * Great-circle distance in metres between two profiles, or null if either has
 * no location set.
 */
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

/**
 * Profiles within `radiusMetres` of a point, nearest first.
 *
 * `ST_DWithin` is the indexed operator — it uses the GIST index on
 * `profiles.location`. `ST_Distance` in the SELECT and ORDER BY does not use
 * the index, which is why the filter must be `ST_DWithin` and not a comparison
 * against `ST_Distance`.
 *
 * This is the geospatial half of the deck query only. It applies no block,
 * mode, age, or already-swiped filtering — Batch 7 composes those into the
 * shared exclusion clause (spec §5.5). Do not use this directly as a deck.
 */
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

/**
 * Venues within a radius, nearest first (spec §5.9: sorted by distance,
 * filterable by category).
 */
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

/**
 * Records a position on an active sharing session.
 *
 * spec §5.7 calls live location high-risk data and asks for no historical trail
 * beyond the immediate safety need. The retention rule is enforced by
 * `pruneExpiredLiveLocations` below, not by the client choosing to stop sending.
 */
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

/** The most recent positions on a session, newest first. */
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

/**
 * Deletes the position trail of sessions that have ended or lapsed.
 *
 * The session row survives — it is the audit record that sharing happened, and
 * a safety investigation needs to know that. The POSITIONS do not: spec §5.7
 * says retain no historical trail beyond the immediate need, and a stored
 * movement history is the single most damaging thing this database could leak.
 */
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

/** Emergency events carry a position so responders know where to look. */
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
