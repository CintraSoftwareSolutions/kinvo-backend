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
