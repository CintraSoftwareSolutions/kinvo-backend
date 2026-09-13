import { prisma } from '@/db/prisma';
import {
  clearProfileLocation,
  distanceBetweenProfiles,
  findProfilesWithinRadius,
  findVenuesWithinRadius,
  getProfileCoordinates,
  setProfileLocation,
} from '@/db/geo';
import { closeDatabase, resetDatabase } from '../helpers/db';
import {
  CAMDEN,
  LONDON,
  MANCHESTER,
  createUserWithProfile,
  createVenue,
} from '../helpers/factories';

/**
 * The geospatial half of the deck query (spec §5.3, §7 Batch 1's "done when").
 *
 * Distances asserted here are real great-circle distances on the WGS-84
 * spheroid, which is why the expected values have tolerances rather than being
 * exact — PostGIS is more accurate than a flat-earth approximation, and that is
 * the point of using it.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('radius search (spec §5.3)', () => {
  it('returns users inside the radius and excludes those outside', async () => {
    const westminster = await createUserWithProfile({
      display_name: 'Westminster',
      coordinates: LONDON,
    });
    const camden = await createUserWithProfile({ display_name: 'Camden', coordinates: CAMDEN });
    const manchester = await createUserWithProfile({
      display_name: 'Manchester',
      coordinates: MANCHESTER,
    });

    const nearby = await findProfilesWithinRadius(LONDON, 5000);
    const userIds = nearby.map((row) => row.user_id);

    expect(userIds).toContain(westminster.user.id);
    expect(userIds).toContain(camden.user.id);
    expect(userIds).not.toContain(manchester.user.id);
    expect(nearby).toHaveLength(2);
  });

  it('widens correctly — a larger radius picks up the distant user', async () => {
    await createUserWithProfile({ coordinates: LONDON });
    const manchester = await createUserWithProfile({ coordinates: MANCHESTER });

    const tight = await findProfilesWithinRadius(LONDON, 50_000);
    const wide = await findProfilesWithinRadius(LONDON, 400_000);

    expect(tight.map((r) => r.user_id)).not.toContain(manchester.user.id);
    expect(wide.map((r) => r.user_id)).toContain(manchester.user.id);
  });

  it('returns distance in metres, not miles or kilometres (spec §4.6)', async () => {
    await createUserWithProfile({ coordinates: LONDON });
    await createUserWithProfile({ coordinates: CAMDEN });

    const nearby = await findProfilesWithinRadius(LONDON, 10_000);
    const camdenRow = nearby.find((row) => row.distance_metres > 0);

    // Westminster to Camden is roughly 3.7 km. In miles this would be ~2.3;
    // in kilometres, ~3.7. Only metres gives a four-digit number.
    expect(camdenRow?.distance_metres).toBeGreaterThan(3000);
    expect(camdenRow?.distance_metres).toBeLessThan(4500);
    expect(Number.isInteger(camdenRow?.distance_metres)).toBe(true);
  });

  it('orders results nearest first', async () => {
    await createUserWithProfile({ coordinates: LONDON });
    await createUserWithProfile({ coordinates: CAMDEN });
    await createUserWithProfile({ coordinates: MANCHESTER });

    const nearby = await findProfilesWithinRadius(LONDON, 400_000);
    const distances = nearby.map((row) => row.distance_metres);

    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(distances[0]).toBe(0);
  });

  it('excludes users the caller asks to exclude', async () => {
    const self = await createUserWithProfile({ coordinates: LONDON });
    const other = await createUserWithProfile({ coordinates: CAMDEN });

    const nearby = await findProfilesWithinRadius(LONDON, 10_000, {
      excludeUserIds: [self.user.id],
    });

    expect(nearby.map((r) => r.user_id)).toEqual([other.user.id]);
  });

  it('ignores profiles with no location set', async () => {
    await createUserWithProfile({ coordinates: LONDON });
    await createUserWithProfile(); // no coordinates

    const nearby = await findProfilesWithinRadius(LONDON, 400_000);
    expect(nearby).toHaveLength(1);
  });

  it('honours the limit', async () => {
    await createUserWithProfile({ coordinates: LONDON });
    await createUserWithProfile({ coordinates: CAMDEN });
    await createUserWithProfile({ coordinates: LONDON });

    const nearby = await findProfilesWithinRadius(LONDON, 10_000, { limit: 2 });
    expect(nearby).toHaveLength(2);
  });

  it('returns an empty array rather than null when nothing is nearby', async () => {
    await createUserWithProfile({ coordinates: MANCHESTER });

    const nearby = await findProfilesWithinRadius(LONDON, 1000);
    expect(nearby).toEqual([]);
  });
});

describe('reading and writing locations', () => {
  it('round-trips coordinates without swapping longitude and latitude', async () => {
    const { profile } = await createUserWithProfile({ coordinates: LONDON });

    const stored = await getProfileCoordinates(profile.id);

    expect(stored?.longitude).toBeCloseTo(LONDON.longitude, 5);
    expect(stored?.latitude).toBeCloseTo(LONDON.latitude, 5);
    // Latitude 51 in the longitude slot would mean the classic axis-order bug.
    expect(stored?.longitude).toBeLessThan(1);
  });

  it('stamps location_updated_at when a location is written', async () => {
    const { profile } = await createUserWithProfile();

    const before = await prisma.profile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(before.location_updated_at).toBeNull();

    await setProfileLocation(profile.id, LONDON);

    const after = await prisma.profile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(after.location_updated_at).toBeInstanceOf(Date);
  });

  it('clears a location on request', async () => {
    const { profile } = await createUserWithProfile({ coordinates: LONDON });

    await clearProfileLocation(profile.id);

    expect(await getProfileCoordinates(profile.id)).toBeNull();
  });

  it('returns null for a profile that has never set a location', async () => {
    const { profile } = await createUserWithProfile();
    expect(await getProfileCoordinates(profile.id)).toBeNull();
  });

  it('rejects coordinates outside the valid range', async () => {
    const { profile } = await createUserWithProfile();

    await expect(setProfileLocation(profile.id, { longitude: 200, latitude: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(setProfileLocation(profile.id, { longitude: 0, latitude: 91 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      setProfileLocation(profile.id, { longitude: Number.NaN, latitude: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive radius', async () => {
    await expect(findProfilesWithinRadius(LONDON, 0)).rejects.toThrow(RangeError);
    await expect(findProfilesWithinRadius(LONDON, -5)).rejects.toThrow(RangeError);
  });
});

describe('distance between two profiles', () => {
  it('measures Westminster to Camden at roughly 3.7 km', async () => {
    const a = await createUserWithProfile({ coordinates: LONDON });
    const b = await createUserWithProfile({ coordinates: CAMDEN });

    const metres = await distanceBetweenProfiles(a.profile.id, b.profile.id);

    expect(metres).toBeGreaterThan(3000);
    expect(metres).toBeLessThan(4500);
  });

  it('measures London to Manchester at roughly 260 km', async () => {
    const a = await createUserWithProfile({ coordinates: LONDON });
    const b = await createUserWithProfile({ coordinates: MANCHESTER });

    const metres = await distanceBetweenProfiles(a.profile.id, b.profile.id);

    expect(metres).toBeGreaterThan(240_000);
    expect(metres).toBeLessThan(280_000);
  });

  it('is symmetric', async () => {
    const a = await createUserWithProfile({ coordinates: LONDON });
    const b = await createUserWithProfile({ coordinates: CAMDEN });

    const forward = await distanceBetweenProfiles(a.profile.id, b.profile.id);
    const backward = await distanceBetweenProfiles(b.profile.id, a.profile.id);

    expect(forward).toBe(backward);
  });

  it('returns null when either profile has no location', async () => {
    const a = await createUserWithProfile({ coordinates: LONDON });
    const b = await createUserWithProfile();

    expect(await distanceBetweenProfiles(a.profile.id, b.profile.id)).toBeNull();
  });
});

describe('venue search (spec §5.9)', () => {
  it('finds venues within a radius, nearest first', async () => {
    const near = await createVenue({ coordinates: LONDON, category: 'cafe' });
    const mid = await createVenue({ coordinates: CAMDEN, category: 'park' });
    const far = await createVenue({ coordinates: MANCHESTER, category: 'cafe' });

    const results = await findVenuesWithinRadius(LONDON, 10_000);
    const ids = results.map((row) => row.venue_id);

    expect(ids).toEqual([near.id, mid.id]);
    expect(ids).not.toContain(far.id);
  });

  it('filters by category', async () => {
    const cafe = await createVenue({ coordinates: LONDON, category: 'cafe' });
    await createVenue({ coordinates: CAMDEN, category: 'gym' });

    const results = await findVenuesWithinRadius(LONDON, 10_000, { category: 'cafe' });

    expect(results.map((r) => r.venue_id)).toEqual([cafe.id]);
  });

  it('excludes inactive venues', async () => {
    const venue = await createVenue({ coordinates: LONDON });
    await prisma.venue.update({ where: { id: venue.id }, data: { is_active: false } });

    expect(await findVenuesWithinRadius(LONDON, 10_000)).toEqual([]);
  });
});

describe('spatial indexing', () => {
  it('has a GIST index on every geography column', async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string; tablename: string }[]>`
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE '%USING gist%'
      ORDER BY indexname
    `;

    const tables = indexes.map((row) => row.tablename).sort();

    // Without these, ST_DWithin degrades to a sequential scan over every user
    // on every deck build.
    expect(tables).toEqual(['emergency_events', 'live_location_pings', 'profiles', 'venues']);
  });
});
