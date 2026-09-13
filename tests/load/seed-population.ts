import { randomUUID } from 'node:crypto';

import { prisma } from '@/db/prisma';
import { logger } from '@utils/logger';

/**
 * Synthetic population for the deck load test (spec §7, Batch 15).
 *
 * The deck is the query worth load-testing: it is the only endpoint where a
 * PostGIS radius search, six filters and a ranking pass run on every request,
 * and it is the first screen of the product. A regression here is felt by
 * everyone at once.
 *
 * Written as bulk SQL rather than through Prisma or the API. Creating fifty
 * thousand users a row at a time takes long enough that the seeding, not the
 * measurement, becomes the experiment — and the point is the SHAPE of the deck
 * query at scale, not how fast rows insert.
 *
 * Locations are scattered across roughly Greater London so the radius filter
 * has to actually discriminate. A population sharing one coordinate would make
 * the GIST index look useless and the query look fast, which is the opposite of
 * a useful measurement.
 */

const LONDON = { longitude: -0.1276, latitude: 51.5072 };

/** ~0.4 degrees, a little over 40km — comfortably wider than the default radius. */
const SPREAD_DEGREES = 0.4;

const DEFAULT_COUNT = Number(process.env.LOAD_POPULATION ?? 20_000);
const BATCH = 1_000;

function scatter(index: number): { longitude: number; latitude: number } {
  // Deterministic rather than random, so two runs measure the same population
  // and a comparison between them means something.
  const golden = 2.399963229728653;
  const angle = index * golden;
  const radius = Math.sqrt((index % BATCH) / BATCH) * SPREAD_DEGREES;

  return {
    longitude: LONDON.longitude + radius * Math.cos(angle),
    latitude: LONDON.latitude + radius * Math.sin(angle),
  };
}

export async function seedPopulation(count = DEFAULT_COUNT): Promise<{ created: number }> {
  const existing = await prisma.user.count({
    where: { display_name: { startsWith: 'Load User' } },
  });

  if (existing >= count) {
    logger.info({ existing }, 'load population already present');
    return { created: 0 };
  }

  const toCreate = count - existing;
  let created = 0;

  for (let offset = 0; offset < toCreate; offset += BATCH) {
    const size = Math.min(BATCH, toCreate - offset);

    const users = Array.from({ length: size }, (_, i) => {
      const index = existing + offset + i;
      return {
        id: randomUUID(),
        profileId: randomUUID(),
        index,
        ...scatter(index),
        // 18 to 58, so age filtering has something to exclude.
        age: 18 + (index % 40),
      };
    });

    // One statement per table rather than per row. The geography column is
    // written here directly because Prisma cannot express it (see geo.ts) —
    // this is the same ST_MakePoint(lon, lat) ordering used everywhere else.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`
        INSERT INTO users (id, display_name, date_of_birth, status, is_verified, is_snoozed,
                           onboarded_at, last_active_at, subscription_tier, role, created_at, updated_at)
        VALUES ${users
          .map(
            (u) =>
              `('${u.id}', 'Load User ${u.index}', (now() - interval '${u.age} years')::date,
                'active', ${u.index % 5 === 0}, false, now(), now(), 'free', 'user', now(), now())`,
          )
          .join(',')}
      `),
      prisma.$executeRawUnsafe(`
        INSERT INTO auth_identities (id, user_id, provider, identifier, verified_at, created_at, updated_at)
        VALUES ${users
          .map(
            (u) =>
              `('${randomUUID()}', '${u.id}', 'email', 'load-${u.index}@kinvo.test', now(), now(), now())`,
          )
          .join(',')}
      `),
      prisma.$executeRawUnsafe(`
        INSERT INTO profiles (id, user_id, bio, city, country, location, created_at, updated_at)
        VALUES ${users
          .map(
            (u) =>
              `('${u.profileId}', '${u.id}', 'Load test profile', 'London', 'GB',
                ST_SetSRID(ST_MakePoint(${u.longitude}, ${u.latitude}), 4326)::geography, now(), now())`,
          )
          .join(',')}
      `),
      prisma.$executeRawUnsafe(`
        INSERT INTO user_modes (id, user_id, mode, is_enabled, is_primary, radius_metres,
                                min_age, max_age, verified_only, created_at, updated_at)
        VALUES ${users
          .map(
            (u) =>
              `('${randomUUID()}', '${u.id}', 'dating', true, true, 48280, 18, 99, false, now(), now())`,
          )
          .join(',')}
      `),
    ]);

    created += size;
    logger.info({ created, target: toCreate }, 'seeding load population');
  }

  return { created };
}

/** Removes everything this script created, and nothing else. */
export async function clearPopulation(): Promise<number> {
  const result = await prisma.user.deleteMany({
    where: { display_name: { startsWith: 'Load User' } },
  });

  return result.count;
}

if (require.main === module) {
  const run = process.argv.includes('--clear')
    ? clearPopulation().then((n) => ({ created: -n }))
    : seedPopulation();

  run
    .then((result) => {
      logger.info(result, 'load population ready');
      return prisma.$disconnect();
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'load population failed');
      process.exitCode = 1;
      return prisma.$disconnect();
    });
}
