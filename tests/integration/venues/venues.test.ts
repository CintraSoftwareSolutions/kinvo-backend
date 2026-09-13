import { API_PREFIX } from '@config/constants';
import { Mode, prisma } from '@/db/prisma';
import { setVenueLocation } from '@/db/geo';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { CAMDEN, LONDON, MANCHESTER } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair } from '../../helpers/chat';

/**
 * Venues (spec §5.9, Batch 12).
 *
 * Admin-curated, distance-sorted, filterable by category, and tuned to the
 * mode a match shares. Read-only for users — creating and editing belongs to
 * the admin module, because this list is where the product suggests two
 * strangers meet.
 */

const VENUES = `${API_PREFIX}/venues`;

async function createVenue(options: {
  name: string;
  category?: string;
  coordinates?: { latitude: number; longitude: number };
  modes?: Mode[];
  active?: boolean;
}) {
  const venue = await prisma.venue.create({
    data: {
      name: options.name,
      category: (options.category ?? 'cafe') as never,
      city: 'London',
      country: 'GB',
      modes: options.modes ?? [Mode.dating],
      is_active: options.active ?? true,
    },
  });

  if (options.coordinates) {
    await setVenueLocation(venue.id, options.coordinates);
  }

  return venue;
}

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('GET /venues', () => {
  it('returns nearby venues, nearest first', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await createVenue({ name: 'Far', coordinates: CAMDEN });
    await createVenue({ name: 'Near', coordinates: LONDON });

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.venues.map((v: { name: string }) => v.name)).toEqual(['Near', 'Far']);
  });

  it('returns distance in metres (spec §4.6)', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createVenue({ name: 'Camden spot', coordinates: CAMDEN });

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    // Westminster to Camden is roughly 3.7 km. Miles would be ~2.3.
    expect(response.body.data.venues[0].distance_metres).toBeGreaterThan(3000);
    expect(response.body.data.venues[0].distance_metres).toBeLessThan(5000);
  });

  it('excludes venues outside the radius', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await createVenue({ name: 'Close', coordinates: CAMDEN });
    await createVenue({ name: 'Manchester', coordinates: MANCHESTER });

    const response = await api.get(`${VENUES}?radius_metres=10000`).set(authHeader(user.tokens));

    expect(response.body.data.venues.map((v: { name: string }) => v.name)).toEqual(['Close']);
  });

  it('filters by category', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await createVenue({ name: 'A cafe', category: 'cafe', coordinates: LONDON });
    await createVenue({ name: 'A gym', category: 'gym', coordinates: LONDON });

    const response = await api.get(`${VENUES}?category=gym`).set(authHeader(user.tokens));

    expect(response.body.data.venues.map((v: { name: string }) => v.name)).toEqual(['A gym']);
  });

  it('filters by mode, so suggestions suit the conversation', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await createVenue({ name: 'Romantic', coordinates: LONDON, modes: [Mode.dating] });
    await createVenue({ name: 'Library', coordinates: LONDON, modes: [Mode.study_buddy] });

    const response = await api.get(`${VENUES}?mode=study_buddy`).set(authHeader(user.tokens));

    // A venue tagged for study_buddy must not surface in cuddle, and vice versa.
    expect(response.body.data.venues.map((v: { name: string }) => v.name)).toEqual(['Library']);
  });

  it('hides inactive venues', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    await createVenue({ name: 'Closed down', coordinates: LONDON, active: false });

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.body.data.venues).toEqual([]);
  });

  it('searches around a given point instead of the profile location', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    await createVenue({ name: 'Manchester spot', coordinates: MANCHESTER });

    const response = await api
      .get(`${VENUES}?latitude=${MANCHESTER.latitude}&longitude=${MANCHESTER.longitude}`)
      .set(authHeader(user.tokens));

    // Browsing another area must not require moving your profile location.
    expect(response.body.data.venues).toHaveLength(1);
  });

  it('requires both coordinates or neither', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(`${VENUES}?latitude=51.5`).set(authHeader(user.tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });

  it('returns an empty array, never null', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.body.data.venues).toEqual([]);
  });

  it('requires a token', async () => {
    const response = await api.get(VENUES);

    expect(response.status).toBe(401);
  });
});

describe('saving venues', () => {
  it('saves, lists, and unsaves', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const venue = await createVenue({ name: 'Keeper', coordinates: LONDON });

    const saved = await api.post(`${VENUES}/${venue.id}/save`).set(authHeader(user.tokens));
    expect(saved.status).toBe(201);

    const list = await api.get(`${VENUES}/saved`).set(authHeader(user.tokens));
    expect(list.body.data.venues).toHaveLength(1);
    expect(list.body.data.venues[0].is_saved).toBe(true);

    const removed = await api.delete(`${VENUES}/${venue.id}/save`).set(authHeader(user.tokens));
    expect(removed.status).toBe(200);

    const after = await api.get(`${VENUES}/saved`).set(authHeader(user.tokens));
    expect(after.body.data.venues).toEqual([]);
  });

  it('is idempotent', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const venue = await createVenue({ name: 'Keeper', coordinates: LONDON });

    await api.post(`${VENUES}/${venue.id}/save`).set(authHeader(user.tokens));
    const second = await api.post(`${VENUES}/${venue.id}/save`).set(authHeader(user.tokens));

    expect(second.status).toBe(201);
    expect(await prisma.savedVenue.count()).toBe(1);
  });

  it('marks is_saved in search results', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const venue = await createVenue({ name: 'Saved one', coordinates: LONDON });
    await createVenue({ name: 'Not saved', coordinates: LONDON });

    await api.post(`${VENUES}/${venue.id}/save`).set(authHeader(user.tokens));

    const response = await api.get(VENUES).set(authHeader(user.tokens));
    const saved = response.body.data.venues.find((v: { name: string }) => v.name === 'Saved one');
    const other = response.body.data.venues.find((v: { name: string }) => v.name === 'Not saved');

    expect(saved.is_saved).toBe(true);
    expect(other.is_saved).toBe(false);
  });

  it('keeps saved lists separate per user', async () => {
    const one = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const two = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const venue = await createVenue({ name: 'Shared venue', coordinates: LONDON });

    await api.post(`${VENUES}/${venue.id}/save`).set(authHeader(one.tokens));

    const theirs = await api.get(`${VENUES}/saved`).set(authHeader(two.tokens));
    expect(theirs.body.data.venues).toEqual([]);
  });

  it('404s unsaving something that was not saved', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const venue = await createVenue({ name: 'Never saved', coordinates: LONDON });

    const response = await api.delete(`${VENUES}/${venue.id}/save`).set(authHeader(user.tokens));

    expect(response.status).toBe(404);
  });
});

describe('GET /venues/suggest/:match_id', () => {
  it('suggests venues matching the mode of the match', async () => {
    const { a, match_id } = await matchPair(Mode.study_buddy);

    await createVenue({ name: 'Library', coordinates: LONDON, modes: [Mode.study_buddy] });
    await createVenue({ name: 'Wine bar', coordinates: LONDON, modes: [Mode.dating] });

    const response = await api.get(`${VENUES}/suggest/${match_id}`).set(authHeader(a.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.venues.map((v: { name: string }) => v.name)).toEqual(['Library']);
  });

  it('404s on a match the caller is not in', async () => {
    const { match_id } = await matchPair(Mode.dating);
    const stranger = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api
      .get(`${VENUES}/suggest/${match_id}`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
  });
});

describe('GET /venues/:id', () => {
  it('returns one venue', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const venue = await createVenue({ name: 'The place', coordinates: LONDON });

    const response = await api.get(`${VENUES}/${venue.id}`).set(authHeader(user.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('The place');
  });

  it('404s on an inactive venue', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });
    const venue = await createVenue({ name: 'Gone', coordinates: LONDON, active: false });

    const response = await api.get(`${VENUES}/${venue.id}`).set(authHeader(user.tokens));

    expect(response.status).toBe(404);
  });

  it('does not read "saved" as a venue id', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: LONDON });

    const response = await api.get(`${VENUES}/saved`).set(authHeader(user.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.venues).toEqual([]);
  });
});
