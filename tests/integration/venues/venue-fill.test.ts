import { API_PREFIX } from '@config/constants';
import { Mode, VenueCategory, VenueSource, prisma } from '@/db/prisma';
import { type Coordinates, setVenueLocation } from '@/db/geo';
import { redis } from '@/db/redis';
import {
  type ExternalPlace,
  type PlaceSearch,
  type PlacesProvider,
  setPlacesProvider,
} from '@/providers/places.provider';
import {
  AREA_RETRY_SECONDS,
  MODES_FOR_CATEGORY,
  areaFor,
} from '@modules/venues/venue-fill.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { MANCHESTER } from '../../helpers/factories';
import { createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';

// Places from a provider (DECISIONS.md, 6 Oct 2026): fetched once per area,
// listed after Kinvo's own venues, never at the cost of the search.

const VENUES = `${API_PREFIX}/venues`;
const ISLAMABAD: Coordinates = { latitude: 33.6938, longitude: 73.0652 };
const NEAR: Coordinates = { latitude: 33.6941, longitude: 73.0655 };
const FURTHER: Coordinates = { latitude: 33.699, longitude: 73.072 };

class FakePlaces implements PlacesProvider {
  readonly source = VenueSource.geoapify;
  readonly searches: PlaceSearch[] = [];
  places: Partial<Record<VenueCategory, ExternalPlace[]>> = {};
  failing = false;

  search(options: PlaceSearch): Promise<ExternalPlace[]> {
    this.searches.push(options);
    if (this.failing) {
      return Promise.reject(new Error('provider down'));
    }
    return Promise.resolve(this.places[options.category] ?? []);
  }
}

function place(
  externalId: string,
  name: string,
  category: VenueCategory,
  coordinates: Coordinates,
): ExternalPlace {
  return {
    externalId,
    name,
    category,
    coordinates,
    address: 'Jinnah Super, F-7 Markaz',
    city: 'Islamabad',
    country: 'PK',
    websiteUrl: null,
    phone: null,
  };
}

async function curatedVenue(name: string, coordinates: Coordinates) {
  const venue = await prisma.venue.create({
    data: { name, category: VenueCategory.cafe, modes: [Mode.dating], city: 'Islamabad' },
  });
  await setVenueLocation(venue.id, coordinates);
  return venue;
}

async function forgetFetchedAreas(): Promise<void> {
  const keys = await redis.keys('places:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

let provider: FakePlaces;

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
  await forgetFetchedAreas();
  provider = new FakePlaces();
  setPlacesProvider(provider);
});

afterEach(() => setPlacesProvider(null));

afterAll(async () => {
  await forgetFetchedAreas();
  await closeDatabase();
  await disconnectRedis();
});

describe('GET /venues with a places provider', () => {
  it('fills an area the first time it is searched, after Kinvo’s own venues', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });
    await curatedVenue('Kinvo pick', FURTHER);
    provider.places = {
      [VenueCategory.cafe]: [place('geo-cafe', 'Chaaye Khana', VenueCategory.cafe, NEAR)],
      [VenueCategory.park]: [place('geo-park', 'Fatima Jinnah Park', VenueCategory.park, FURTHER)],
    };

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    const venues = response.body.data.venues as { name: string; source: string }[];
    expect(venues.map((venue) => [venue.name, venue.source])).toEqual([
      ['Kinvo pick', 'curated'],
      ['Chaaye Khana', 'geoapify'],
      ['Fatima Jinnah Park', 'geoapify'],
    ]);

    const cafe = await prisma.venue.findFirstOrThrow({ where: { external_id: 'geo-cafe' } });
    expect(cafe.modes).toEqual(MODES_FOR_CATEGORY[VenueCategory.cafe]);
    expect(cafe.address).toBe('Jinnah Super, F-7 Markaz');
  });

  it('fetches an area once, telling the provider the area and not where you are', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });

    await api.get(VENUES).set(authHeader(user.tokens));
    const searchesAfterFirst = provider.searches.length;
    await api.get(VENUES).set(authHeader(user.tokens));
    await api.get(`${VENUES}?category=cafe`).set(authHeader(user.tokens));

    expect(searchesAfterFirst).toBe(6);
    expect(provider.searches).toHaveLength(6);
    for (const search of provider.searches) {
      expect(search.centre).toEqual(areaFor(ISLAMABAD).centre);
      expect(search.centre).not.toEqual(ISLAMABAD);
    }
  });

  it('fetches again for an area it has not seen', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });

    await api.get(VENUES).set(authHeader(user.tokens));
    await api
      .get(`${VENUES}?latitude=${MANCHESTER.latitude}&longitude=${MANCHESTER.longitude}`)
      .set(authHeader(user.tokens));

    expect(provider.searches).toHaveLength(12);
  });

  it('answers with what it has when the provider fails, and tries the area again later', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });
    await curatedVenue('Kinvo pick', NEAR);
    provider.failing = true;

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.venues.map((venue: { name: string }) => venue.name)).toEqual([
      'Kinvo pick',
    ]);
    const ttl = await redis.ttl(`places:area:geoapify:${areaFor(ISLAMABAD).key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(AREA_RETRY_SECONDS);
  });

  it('stops asking once the day’s credits are spent', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });
    const today = new Date().toISOString().slice(0, 10);
    await redis.set(`places:credits:${today}`, '2500');

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.status).toBe(200);
    expect(provider.searches).toHaveLength(0);
  });

  it('refreshes what the provider describes and keeps what Kinvo decided', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });
    provider.places = {
      [VenueCategory.cafe]: [place('geo-cafe', 'Chaaye Khana', VenueCategory.cafe, NEAR)],
    };
    await api.get(VENUES).set(authHeader(user.tokens));
    await prisma.venue.updateMany({
      where: { external_id: 'geo-cafe' },
      data: { is_active: false, modes: [Mode.foodie] },
    });

    await forgetFetchedAreas();
    provider.places = {
      [VenueCategory.cafe]: [place('geo-cafe', 'Chaaye Khana F-7', VenueCategory.cafe, NEAR)],
    };
    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.body.data.venues).toEqual([]);
    const cafe = await prisma.venue.findFirstOrThrow({ where: { external_id: 'geo-cafe' } });
    expect(cafe.name).toBe('Chaaye Khana F-7');
    expect(cafe.is_active).toBe(false);
    expect(cafe.modes).toEqual([Mode.foodie]);
    expect(await prisma.venue.count({ where: { external_id: 'geo-cafe' } })).toBe(1);
  });

  it('lets a place from the provider be saved like any other', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });
    provider.places = {
      [VenueCategory.cafe]: [place('geo-cafe', 'Chaaye Khana', VenueCategory.cafe, NEAR)],
    };
    const listed = await api.get(VENUES).set(authHeader(user.tokens));
    const id = listed.body.data.venues[0].id as string;

    const saved = await api.post(`${VENUES}/${id}/save`).set(authHeader(user.tokens));
    const list = await api.get(`${VENUES}/saved`).set(authHeader(user.tokens));

    expect(saved.status).toBe(201);
    expect(list.body.data.venues).toEqual([
      expect.objectContaining({ id, source: 'geoapify', is_saved: true }),
    ]);
  });

  it('lists only Kinvo’s venues when no provider is set up', async () => {
    const user = await createDiscoverableViewer({ mode: Mode.dating, coordinates: ISLAMABAD });
    const search = jest.fn<Promise<ExternalPlace[]>, [PlaceSearch]>();
    setPlacesProvider({ source: null, search });
    await curatedVenue('Kinvo pick', NEAR);

    const response = await api.get(VENUES).set(authHeader(user.tokens));

    expect(response.body.data.venues.map((venue: { name: string }) => venue.name)).toEqual([
      'Kinvo pick',
    ]);
    expect(search).not.toHaveBeenCalled();
  });
});
