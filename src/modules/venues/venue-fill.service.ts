import { Mode, VenueCategory } from '@/db/prisma';
import { type Coordinates, type SourcedVenue, upsertSourcedVenues } from '@/db/geo';
import { redis } from '@/db/redis';
import {
  type ExternalPlace,
  PROVIDED_CATEGORIES,
  getPlacesProvider,
} from '@/providers/places.provider';
import { env } from '@config/env';
import { logger } from '@utils/logger';

// Areas are cells of a grid about 5.5 km tall. The provider is only ever told
// a cell's centre, never where the person searching is.
export const CELL_DEGREES = 0.05;
export const FETCH_RADIUS_METRES = 8_000;
// One credit buys up to 20 places.
export const PLACES_PER_CATEGORY = 20;
export const AREA_FRESH_SECONDS = 7 * 24 * 60 * 60;
export const AREA_RETRY_SECONDS = 10 * 60;
export const FILL_TIMEOUT_MS = 4_000;

// The modes each kind of place suits, as for Kinvo's own venues.
export const MODES_FOR_CATEGORY: Readonly<Partial<Record<VenueCategory, Mode[]>>> = {
  [VenueCategory.cafe]: [Mode.dating, Mode.study_buddy, Mode.networking, Mode.foodie, Mode.trading],
  [VenueCategory.restaurant]: [Mode.dating, Mode.foodie, Mode.networking, Mode.trading],
  [VenueCategory.park]: [Mode.dating, Mode.pet_dates, Mode.fitness, Mode.cuddle],
  [VenueCategory.gym]: [Mode.fitness, Mode.dating],
  [VenueCategory.study_spot]: [Mode.study_buddy],
  [VenueCategory.pet_friendly]: [Mode.pet_dates, Mode.fitness, Mode.dating],
};

export interface Area {
  key: string;
  centre: Coordinates;
}

export function areaFor({ latitude, longitude }: Coordinates): Area {
  const row = Math.floor(latitude / CELL_DEGREES);
  const column = Math.floor(longitude / CELL_DEGREES);
  return {
    key: `${row}:${column}`,
    centre: {
      latitude: Number(((row + 0.5) * CELL_DEGREES).toFixed(5)),
      longitude: Number(((column + 0.5) * CELL_DEGREES).toFixed(5)),
    },
  };
}

function toSourcedVenue(place: ExternalPlace): SourcedVenue {
  return {
    externalId: place.externalId,
    name: place.name,
    category: place.category,
    modes: MODES_FOR_CATEGORY[place.category] ?? [],
    coordinates: place.coordinates,
    address: place.address,
    city: place.city,
    country: place.country,
    websiteUrl: place.websiteUrl,
    phone: place.phone,
  };
}

async function spendCredits(credits: number, now: Date): Promise<boolean> {
  const key = `places:credits:${now.toISOString().slice(0, 10)}`;
  const spent = await redis.incrby(key, credits);
  if (spent === credits) {
    await redis.expire(key, 2 * 24 * 60 * 60);
  }
  return spent <= env.PLACES_DAILY_CREDIT_LIMIT;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Best effort: whatever goes wrong, the search carries on with the venues it
// already has, and the area is tried again a little later.
export async function fillAreaFromProvider(centre: Coordinates, now = new Date()): Promise<void> {
  const provider = getPlacesProvider();
  const source = provider.source;
  if (!source) {
    return;
  }

  const area = areaFor(centre);
  const areaKey = `places:area:${source}:${area.key}`;
  const categories = Object.keys(PROVIDED_CATEGORIES) as VenueCategory[];

  try {
    // One request fetches an area; the others go on with what is saved.
    const claimed = await redis.set(areaKey, 'fetching', 'EX', AREA_FRESH_SECONDS, 'NX');
    if (claimed !== 'OK') {
      return;
    }

    if (!(await spendCredits(categories.length, now))) {
      await redis.set(areaKey, 'over-budget', 'EX', AREA_RETRY_SECONDS);
      logger.warn({ source }, 'places daily credit limit reached');
      return;
    }

    const signal = AbortSignal.timeout(FILL_TIMEOUT_MS);
    const results = await Promise.allSettled(
      categories.map((category) =>
        provider.search({
          centre: area.centre,
          radiusMetres: FETCH_RADIUS_METRES,
          category,
          limit: PLACES_PER_CATEGORY,
          signal,
        }),
      ),
    );

    const failures = results.filter((result) => result.status === 'rejected');
    const byId = new Map<string, ExternalPlace>();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const place of result.value) {
        if (!byId.has(place.externalId)) byId.set(place.externalId, place);
      }
    }

    await upsertSourcedVenues(source, [...byId.values()].map(toSourcedVenue));

    if (failures.length > 0) {
      logger.warn(
        {
          source,
          failed: failures.length,
          of: results.length,
          reason: reasonOf((failures[0] as PromiseRejectedResult).reason),
        },
        'some places requests failed',
      );
      await redis.set(areaKey, 'partial', 'EX', AREA_RETRY_SECONDS);
      return;
    }

    await redis.set(areaKey, 'done', 'EX', AREA_FRESH_SECONDS);
  } catch (error) {
    logger.warn({ source, reason: reasonOf(error) }, 'could not fill an area with places');
    await redis.set(areaKey, 'failed', 'EX', AREA_RETRY_SECONDS).catch(() => undefined);
  }
}
