import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Runs once, before any test file.
 *
 * Applies migrations to the test database so `npm test` works from a clean
 * checkout with nothing but `docker compose up` (spec §0.4). Uses
 * `migrate deploy` rather than `migrate dev`: deploy applies committed
 * migrations and never generates new ones or prompts.
 */

/**
 * Resolves the Prisma CLI entry point so it can be run with the current Node
 * binary directly.
 *
 * Not `npx`: Node refuses to spawn a `.cmd` shim without a shell on Windows
 * (EINVAL, since the CVE-2024-27980 fix), and passing args through a shell does
 * not escape them (DEP0190). Running the CLI's JavaScript with `process.execPath`
 * avoids both, and works identically on Linux for CI.
 */
function resolvePrismaCli(): string {
  const manifestPath = require.resolve('prisma/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };

  const binField = manifest.bin;
  const relative = typeof binField === 'string' ? binField : (binField?.prisma ?? 'build/index.js');

  return path.join(path.dirname(manifestPath), relative);
}

/** Migration directory names, which are also the values stored in the ledger. */
function committedMigrations(): string[] {
  const dir = path.join(__dirname, '..', 'prisma', 'migrations');

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Confirms the schema is current WITHOUT running the Prisma CLI.
 *
 * Prisma's schema engine is a native binary, and some host security policies —
 * Windows Smart App Control, corporate application allow-listing — refuse to
 * execute it. That blocks `migrate deploy` while leaving the database and the
 * application perfectly healthy, because Prisma 7 talks to Postgres through
 * `@prisma/adapter-pg`, which is plain JavaScript with no engine binary.
 *
 * So when the CLI cannot run, this compares the committed migrations against
 * the `_prisma_migrations` ledger directly. Every migration applied means the
 * schema is current and the suite is safe to run. Anything missing means it is
 * genuinely out of date, and that fails loudly — this is a different way of
 * verifying, not a way of skipping.
 */
async function verifyMigrationsApplied(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
    );

    const applied = new Set(result.rows.map((row) => row.migration_name));
    const pending = committedMigrations().filter((name) => !applied.has(name));

    if (pending.length > 0) {
      throw new Error(
        `The test database is missing ${pending.length} migration(s):\n` +
          `  ${pending.join('\n  ')}\n\n` +
          "Prisma's migration binary could not run on this host, so they cannot be\n" +
          'applied automatically. Apply them from an environment that can run it —\n' +
          'WSL, a container, or CI — with:\n' +
          '  npm run db:deploy',
      );
    }
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ?? 'postgresql://kinvo:kinvo@localhost:5433/kinvo_test';

  try {
    execFileSync(process.execPath, [resolvePrismaCli(), 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    return;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    // A blocked or missing native binary is a HOST problem, not a schema
    // problem, and it is worth distinguishing: the database may be perfectly
    // up to date. Anything else — an unreachable database, a broken
    // migration — is a real failure and must not fall through to the
    // ledger check.
    const binaryBlocked =
      details.includes('spawn UNKNOWN') ||
      details.includes('Application Control') ||
      details.includes('EPERM') ||
      details.includes('Schema engine exited');

    if (!binaryBlocked) {
      throw new Error(
        'Could not migrate the test database.\n' +
          'Is Docker running? Start it with `npm run db:up`.\n' +
          `Target: ${databaseUrl}\n\n${details}`,
      );
    }

    try {
      await verifyMigrationsApplied(databaseUrl);
    } catch (verifyError) {
      const reason = verifyError instanceof Error ? verifyError.message : String(verifyError);
      throw new Error(
        `Prisma's migration binary could not run on this host.\n\n${reason}\n\n` +
          `Original error: ${details}`,
      );
    }
  }
}
