import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Proves the mobile app's contract has not moved.
 *
 * WHY THIS EXISTS. The app is shipped. Every remaining piece of admin work is
 * additive by constraint — a renamed field or a changed status code in anything
 * the app calls is a broken release, and it is the kind of change that is easy
 * to make by accident while refactoring a shared service.
 *
 * "I did not change it" is not a guarantee. This is: it takes the generated
 * contract, removes the admin paths, and compares what remains against the
 * committed baseline. Identical means nothing the app can see has changed.
 *
 * Run it after `npm run docs:export`:
 *
 *   npm run verify:contract                 # against HEAD
 *   BASE=origin/main npm run verify:contract
 *
 * It compares the GENERATED document rather than reading the code, so it
 * catches a change made anywhere — a route, a schema, a response shape — not
 * just the ones somebody thought to look at.
 */

/** Paths the app never calls. Everything else is the contract under guard. */
const ADMIN_PREFIXES = ['  /api/v1/admin/'];

const BASE = process.env.BASE ?? 'HEAD';
const CONTRACT = 'docs/openapi.yaml';

/**
 * Drops each admin path block.
 *
 * Keys off the two-space indent that OpenAPI gives a path entry, so a nested
 * line mentioning the same string cannot start or stop a block by accident.
 */
function stripAdminPaths(yaml: string): string {
  const kept: string[] = [];
  let skipping = false;

  for (const line of yaml.split('\n')) {
    if (/^ {2}\/api\/v1\//.test(line)) {
      skipping = ADMIN_PREFIXES.some((prefix) => line.startsWith(prefix));
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join('\n');
}

function baselineContract(): string {
  try {
    return execFileSync('git', ['show', `${BASE}:${CONTRACT}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      `Could not read ${CONTRACT} at ${BASE}. Commit the baseline, or set BASE to a ref that has it.`,
    );
  }
}

function firstDifference(a: string[], b: string[]): string[] {
  const report: string[] = [];

  for (let i = 0; i < Math.max(a.length, b.length) && report.length < 20; i += 1) {
    if (a[i] !== b[i]) {
      report.push(`  line ${i + 1}`);
      report.push(`    baseline: ${a[i] ?? '(end of file)'}`);
      report.push(`    now:      ${b[i] ?? '(end of file)'}`);
    }
  }

  return report;
}

const baseline = stripAdminPaths(baselineContract());
const current = stripAdminPaths(readFileSync(CONTRACT, 'utf8'));

/* eslint-disable no-console -- a CLI script's output IS its result. */
if (baseline === current) {
  console.log(`App contract unchanged against ${BASE}.`);
  console.log(`  ${baseline.split('\n').length} lines compared, admin paths excluded.`);
} else {
  console.error(`THE APP CONTRACT CHANGED against ${BASE}.`);
  console.error('');
  console.error('Something the mobile app calls is no longer the same. That is a broken');
  console.error('release, not a refactor — find it before committing.');
  console.error('');
  console.error(firstDifference(baseline.split('\n'), current.split('\n')).join('\n'));
  process.exitCode = 1;
}
/* eslint-enable no-console */
