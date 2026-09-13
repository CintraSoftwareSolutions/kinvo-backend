import { prisma } from '@/db/prisma';

/**
 * Test database lifecycle.
 *
 * spec §0.4: tests seed and clean their own data and must run in any order.
 * `resetDatabase()` is the mechanism — call it in beforeEach so no test can
 * depend on another having run.
 */

/** Never truncated: migration bookkeeping and the PostGIS reference table. */
const PROTECTED_TABLES = ['_prisma_migrations', 'spatial_ref_sys'];

let cachedTables: string[] | null = null;

async function listTables(): Promise<string[]> {
  if (cachedTables) {
    return cachedTables;
  }

  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `;

  cachedTables = rows
    .map((row) => row.tablename)
    .filter((name) => !PROTECTED_TABLES.includes(name));

  return cachedTables;
}

/**
 * Empties every application table in one statement.
 *
 * A single TRUNCATE ... CASCADE is dramatically faster than deleting per table
 * and sidesteps foreign-key ordering entirely.
 *
 * Uses $executeRawUnsafe because table names are identifiers, which cannot be
 * bound as parameters. The names come from pg_tables — the database's own
 * catalogue — never from user input.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await listTables();
  if (tables.length === 0) {
    return;
  }

  const quoted = tables.map((name) => `"public"."${name}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

/** Closes the connection pool so Jest can exit cleanly. */
export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma };
