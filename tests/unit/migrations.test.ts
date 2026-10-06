import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Guards on the committed migration history.
 *
 * WHY THIS FILE EXISTS. `prisma migrate dev` cannot see the PostGIS GIST
 * indexes, because the columns they cover are `Unsupported("geography")` — the
 * one thing Prisma has no model for. So every generated migration reads them as
 * drift and emits a `DROP INDEX` for each.
 *
 * Applying that costs nothing at migrate time, raises no error, and turns every
 * radius query into a sequential scan. The deck builder, venue search and the
 * safety location trail all go through those indexes, so the first symptom is
 * the product getting slower under load with nothing in the logs.
 *
 * It has been generated and caught by hand three times. A reviewer reading a
 * forty-line migration will eventually miss it, so this asserts it instead.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory())
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }));
}

describe('committed migrations', () => {
  it('finds migrations to check', () => {
    // A guard that silently checks nothing is worse than no guard: if the
    // directory moves, this fails rather than passing on an empty list.
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  it('never drops a PostGIS GIST index', () => {
    const offenders = migrationFiles()
      .map(({ name, sql }) => {
        // Comments explaining the hazard are expected and must not trip this,
        // so only statement lines count.
        const statements = sql
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n');

        const dropped = [...statements.matchAll(/DROP\s+INDEX[^;]*?(\w*gist\w*)/gi)].map(
          (match) => match[1],
        );

        return { name, dropped };
      })
      .filter((entry) => entry.dropped.length > 0);

    expect(offenders).toEqual([]);
  });

  it('keeps every GIST index that was ever created', () => {
    const files = migrationFiles();
    const created = new Set<string>();

    for (const { sql } of files) {
      for (const match of sql.matchAll(/CREATE\s+INDEX\s+"?(\w*gist\w*)"?/gi)) {
        created.add(match[1]!);
      }
    }

    // The four spatial indexes the schema relies on. Asserted by name rather
    // than by count, so renaming one is as visible as deleting it.
    expect([...created].sort()).toEqual([
      'emergency_events_location_gist_idx',
      'live_location_pings_location_gist_idx',
      'profiles_location_gist_idx',
      'venues_location_gist_idx',
    ]);
  });
});
