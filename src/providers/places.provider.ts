import { z } from 'zod';

import { VenueCategory, VenueSource } from '@/db/prisma';
import type { Coordinates } from '@/db/geo';
import { env } from '@config/env';

export interface ExternalPlace {
  externalId: string;
  name: string;
  category: VenueCategory;
  coordinates: Coordinates;
  address: string | null;
  city: string | null;
  country: string | null;
  websiteUrl: string | null;
  phone: string | null;
}

export interface PlaceSearch {
  centre: Coordinates;
  radiusMetres: number;
  category: VenueCategory;
  limit: number;
  signal?: AbortSignal;
}

export interface PlacesProvider {
  // null when no provider is configured, and searches find nothing.
  readonly source: VenueSource | null;
  search(options: PlaceSearch): Promise<ExternalPlace[]>;
}

// Only places it makes sense to meet a stranger at. Romantic and
// health-conscious venues have no reliable equivalent, so they stay curated.
export const PROVIDED_CATEGORIES: Readonly<Partial<Record<VenueCategory, string>>> = {
  [VenueCategory.cafe]: 'catering.cafe',
  [VenueCategory.restaurant]: 'catering.restaurant',
  [VenueCategory.park]: 'leisure.park',
  [VenueCategory.gym]: 'sport.fitness',
  [VenueCategory.study_spot]: 'education.library',
  [VenueCategory.pet_friendly]: 'pet.dog_park',
};

const trimmed = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max));

const featureSchema = z.object({
  properties: z.object({
    place_id: trimmed(255),
    name: trimmed(150),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    address_line2: trimmed(300).optional().catch(undefined),
    city: trimmed(120).optional().catch(undefined),
    country_code: z
      .string()
      .regex(/^[a-zA-Z]{2}$/)
      .transform((code) => code.toUpperCase())
      .optional()
      .catch(undefined),
    website: z
      .string()
      .url()
      .max(2048)
      .refine((url) => /^https?:\/\//i.test(url))
      .optional()
      .catch(undefined),
    contact: z
      .object({ phone: trimmed(32).optional().catch(undefined) })
      .optional()
      .catch(undefined),
  }),
});

const responseSchema = z.object({ features: z.array(z.unknown()) });

export function readGeoapifyPlaces(body: unknown, category: VenueCategory): ExternalPlace[] {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Geoapify answered with something other than a feature list');
  }

  const places: ExternalPlace[] = [];
  for (const feature of parsed.data.features) {
    const result = featureSchema.safeParse(feature);
    if (!result.success) continue;
    const place = result.data.properties;
    places.push({
      externalId: place.place_id,
      name: place.name,
      category,
      coordinates: { latitude: place.lat, longitude: place.lon },
      address: place.address_line2 ?? null,
      city: place.city ?? null,
      country: place.country_code ?? null,
      websiteUrl: place.website ?? null,
      phone: place.contact?.phone ?? null,
    });
  }
  return places;
}

const GEOAPIFY_PLACES_URL = 'https://api.geoapify.com/v2/places';

export function createGeoapifyProvider(apiKey: string): PlacesProvider {
  return {
    source: VenueSource.geoapify,

    async search({ centre, radiusMetres, category, limit, signal }) {
      const categories = PROVIDED_CATEGORIES[category];
      if (!categories) return [];

      const url = new URL(GEOAPIFY_PLACES_URL);
      url.searchParams.set('categories', categories);
      url.searchParams.set(
        'filter',
        `circle:${centre.longitude},${centre.latitude},${Math.round(radiusMetres)}`,
      );
      url.searchParams.set('bias', `proximity:${centre.longitude},${centre.latitude}`);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('lang', 'en');
      url.searchParams.set('apiKey', apiKey);

      const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
      if (!response.ok) {
        // The URL carries the key, so only the status is reported.
        throw new Error(`Geoapify places answered ${response.status}`);
      }
      return readGeoapifyPlaces(await response.json(), category);
    },
  };
}

const noPlacesProvider: PlacesProvider = {
  source: null,
  search: () => Promise.resolve([]),
};

let provider: PlacesProvider | null = null;

export function getPlacesProvider(): PlacesProvider {
  provider ??= env.GEOAPIFY_API_KEY
    ? createGeoapifyProvider(env.GEOAPIFY_API_KEY)
    : noPlacesProvider;
  return provider;
}

export function setPlacesProvider(next: PlacesProvider | null): void {
  provider = next;
}
