import { VenueCategory, VenueSource } from '@/db/prisma';
import { createGeoapifyProvider, readGeoapifyPlaces } from '@/providers/places.provider';
import { CELL_DEGREES, areaFor } from '@modules/venues/venue-fill.service';

const API_KEY = 'test-geoapify-key-0123456789';

function feature(properties: Record<string, unknown>) {
  return { type: 'Feature', properties };
}

const kiln = {
  place_id: 'geo-1',
  name: '  Kiln & Kettle ',
  lat: 33.7,
  lon: 73.05,
  address_line2: 'F-7 Markaz, Islamabad',
  city: 'Islamabad',
  country_code: 'pk',
  website: 'https://kiln.example',
  contact: { phone: '+92 51 1234567' },
};

describe('readGeoapifyPlaces', () => {
  it('reads a place, tidied up', () => {
    const [place] = readGeoapifyPlaces({ features: [feature(kiln)] }, VenueCategory.cafe);

    expect(place).toEqual({
      externalId: 'geo-1',
      name: 'Kiln & Kettle',
      category: VenueCategory.cafe,
      coordinates: { latitude: 33.7, longitude: 73.05 },
      address: 'F-7 Markaz, Islamabad',
      city: 'Islamabad',
      country: 'PK',
      websiteUrl: 'https://kiln.example',
      phone: '+92 51 1234567',
    });
  });

  it('leaves out places with no name, no id or no position', () => {
    const places = readGeoapifyPlaces(
      {
        features: [
          feature({ ...kiln, name: '   ' }),
          feature({ ...kiln, place_id: undefined }),
          feature({ ...kiln, lat: 'north' }),
          feature({ ...kiln, lon: 200 }),
          'not a feature',
          feature({ ...kiln, place_id: 'geo-2' }),
        ],
      },
      VenueCategory.cafe,
    );

    expect(places.map((place) => place.externalId)).toEqual(['geo-2']);
  });

  it('drops details it cannot trust, and keeps the place', () => {
    const [place] = readGeoapifyPlaces(
      {
        features: [
          feature({
            ...kiln,
            website: 'javascript:alert(1)',
            country_code: 'PAK',
            contact: { phone: '1'.repeat(40) },
            city: '',
          }),
        ],
      },
      VenueCategory.cafe,
    );

    expect(place).toMatchObject({ websiteUrl: null, country: null, phone: null, city: null });
  });

  it('refuses a body that is not a feature list', () => {
    expect(() => readGeoapifyPlaces({ error: 'nope' }, VenueCategory.cafe)).toThrow();
  });
});

describe('the Geoapify provider', () => {
  let fetchMock: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

  // Never the real network: anything not answered here fails the test.
  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('unexpected network request'));
  });
  afterEach(() => fetchMock.mockRestore());

  it('asks for one kind of place around a point', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ features: [feature(kiln)] })));
    const provider = createGeoapifyProvider(API_KEY);

    const places = await provider.search({
      centre: { latitude: 33.675, longitude: 73.025 },
      radiusMetres: 8000,
      category: VenueCategory.cafe,
      limit: 20,
    });

    expect(provider.source).toBe(VenueSource.geoapify);
    expect(places).toHaveLength(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://api.geoapify.com/v2/places');
    expect(url.searchParams.get('categories')).toBe('catering.cafe');
    expect(url.searchParams.get('filter')).toBe('circle:73.025,33.675,8000');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('apiKey')).toBe(API_KEY);
  });

  it('asks nothing for a kind of place it does not provide', async () => {
    const places = await createGeoapifyProvider(API_KEY).search({
      centre: { latitude: 33.675, longitude: 73.025 },
      radiusMetres: 8000,
      category: VenueCategory.romantic,
      limit: 20,
    });

    expect(places).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a refusal without the key', async () => {
    fetchMock.mockResolvedValue(new Response('Invalid apiKey', { status: 401 }));

    const search = createGeoapifyProvider(API_KEY).search({
      centre: { latitude: 33.675, longitude: 73.025 },
      radiusMetres: 8000,
      category: VenueCategory.park,
      limit: 20,
    });

    await expect(search).rejects.toThrow('Geoapify places answered 401');
    await expect(search).rejects.not.toThrow(API_KEY);
  });
});

describe('areaFor', () => {
  it('gives nearby points the same area, centred on the grid, not on them', () => {
    const a = areaFor({ latitude: 33.6512, longitude: 73.0631 });
    const b = areaFor({ latitude: 33.6588, longitude: 73.0702 });

    expect(a).toEqual(b);
    expect(a.centre).toEqual({ latitude: 33.675, longitude: 73.075 });
    expect(a.centre).not.toEqual({ latitude: 33.6512, longitude: 73.0631 });
  });

  it('starts a new area a cell away', () => {
    const here = areaFor({ latitude: 33.6512, longitude: 73.0631 });
    const north = areaFor({ latitude: 33.6512 + CELL_DEGREES, longitude: 73.0631 });

    expect(north.key).not.toBe(here.key);
  });

  it('works south of the equator and west of Greenwich', () => {
    const area = areaFor({ latitude: -33.8688, longitude: -151.2093 });

    expect(area.centre.latitude).toBeCloseTo(-33.875, 5);
    expect(area.centre.longitude).toBeCloseTo(-151.225, 5);
  });
});
