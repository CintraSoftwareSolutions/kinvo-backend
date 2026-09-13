import autocannon from 'autocannon';

import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import { issueTokenPair } from '@modules/auth/token.service';
import { logger } from '@utils/logger';

/**
 * Load test for the deck endpoint (spec §7, Batch 15).
 *
 * WHY THIS ENDPOINT AND NO OTHER. `GET /discovery/:mode/deck` is the only place
 * a PostGIS radius search, six simultaneous filters and a ranking pass run on
 * every request, and it is the first screen of the product. Everything else is
 * an indexed lookup by id or a cursor page.
 *
 * WHAT IT IS FOR. Not a number to celebrate — a shape to watch. The deck is
 * persisted per (user, mode, day), so the FIRST request of a day for a user
 * builds it and every later one reads it back. Those are different queries with
 * different costs, and a test that only measured warm reads would report a
 * latency the product never experiences at nine in the morning.
 *
 * Run it against a local API with a seeded population:
 *
 *   npm run db:up && npm run dev          # in one terminal
 *   npm run loadtest:seed                 # LOAD_POPULATION=20000 by default
 *   npm run loadtest
 *
 * Not pointed at staging by default. That box has under 2 GB of RAM and shares
 * it with Postgres, so a load test there measures the instance, not the query.
 *
 * RAISE THE RATE LIMIT FIRST. Every request here comes from one address, and
 * the catch-all limiter allows 300 per fifteen minutes per IP. Left alone, a run
 * measures the limiter: the first attempt produced exactly 300 successes and
 * 6,611 rate-limited responses. Start the API with
 * `RATE_LIMIT_GENERAL_MAX=1000000` for a load run.
 */

const TARGET = process.env.LOAD_TARGET ?? 'http://127.0.0.1:3000';
const DURATION_SECONDS = Number(process.env.LOAD_DURATION ?? 20);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 20);

/** How many distinct viewers to rotate through. */
const VIEWERS = Number(process.env.LOAD_VIEWERS ?? 50);

/**
 * Latency ceilings, in milliseconds.
 *
 * Deliberately generous. The purpose is to catch a REGRESSION — a dropped
 * index, a filter that stopped composing, an N+1 that crept into the compact
 * object — not to certify a number. A threshold tight enough to fail on a busy
 * laptop is a threshold people learn to ignore.
 */
const P99_CEILING_MS = Number(process.env.LOAD_P99_CEILING ?? 2_000);

interface Viewer {
  id: string;
  token: string;
}

async function collectViewers(): Promise<Viewer[]> {
  const users = await prisma.user.findMany({
    where: {
      display_name: { startsWith: 'Load User' },
      status: 'active',
      onboarded_at: { not: null },
    },
    select: { id: true },
    take: VIEWERS,
  });

  if (users.length === 0) {
    throw new Error('No load population found. Run `npm run loadtest:seed` first.');
  }

  const viewers: Viewer[] = [];

  for (const user of users) {
    const tokens = await issueTokenPair(user.id);
    viewers.push({ id: user.id, token: tokens.access_token });
  }

  return viewers;
}

/**
 * Proves the spatial index is actually used.
 *
 * A load test can pass on a sequential scan when the table is small, and then
 * fall over in production — so the plan is checked as well as the timing. This
 * is the cheap half of the test and the half that catches a dropped GIST index,
 * which is exactly what `prisma migrate dev` tried to do in Batch 14.
 */
async function explainRadiusQuery(viewer: Viewer): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`
    EXPLAIN ANALYZE
    SELECT p.user_id
      FROM profiles p
      JOIN users u ON u.id = p.user_id
     WHERE ST_DWithin(
             p.location,
             (SELECT location FROM profiles WHERE user_id = '${viewer.id}'),
             48280
           )
       AND u.status = 'active'
       AND u.id <> '${viewer.id}'
     LIMIT 500
  `);

  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

async function main(): Promise<void> {
  const viewers = await collectViewers();
  const population = await prisma.user.count({
    where: { display_name: { startsWith: 'Load User' } },
  });

  logger.info({ population, viewers: viewers.length, target: TARGET }, 'starting deck load test');

  const plan = await explainRadiusQuery(viewers[0]!);
  const usesIndex = /Index Scan|Bitmap Heap Scan|Bitmap Index Scan/i.test(plan);
  const sequential = /Seq Scan on profiles/i.test(plan);

  let index = 0;

  const result = await autocannon({
    url: `${TARGET}${API_PREFIX}/discovery/dating/deck`,
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
    // Each connection rotates through viewers, so this measures many decks
    // rather than one cached deck answered repeatedly.
    setupClient: (client) => {
      const viewer = viewers[index++ % viewers.length]!;
      client.setHeaders({ authorization: `Bearer ${viewer.token}` });
    },
  });

  const p50 = result.latency.p50;
  const p99 = result.latency.p99;

  /**
   * One real request after the run, read in full.
   *
   * autocannon reports how many responses were non-2xx but not WHY, and a
   * status-code counter wired to its event stream reported zero while 12,188
   * responses were failing — so this asks the endpoint directly instead. A
   * single request costs nothing and turns "the endpoint is erroring" into the
   * actual code and message.
   */
  const probeViewer = viewers[0]!;
  const probe = await fetch(`${TARGET}${API_PREFIX}/discovery/dating/deck`, {
    headers: { authorization: `Bearer ${probeViewer.token}` },
  });
  const probeBody = (await probe.json()) as { error?: { code?: string; message?: string } };
  const probeCode = probeBody.error?.code ?? null;

  /* eslint-disable no-console -- a CLI script's output IS its result. */
  console.log('');
  console.log('=== deck load test ===');
  console.log(`population      ${population.toLocaleString()} discoverable users`);
  console.log(`viewers         ${viewers.length} rotating`);
  console.log(`connections     ${CONNECTIONS} for ${DURATION_SECONDS}s`);
  console.log('');
  console.log(`requests        ${result.requests.total} (${result.requests.average}/s)`);
  console.log(`latency p50     ${p50} ms`);
  console.log(`latency p97.5   ${result.latency.p97_5} ms`);
  console.log(`latency p99     ${p99} ms`);
  console.log(`errors          ${result.errors}`);
  console.log(`non-2xx         ${result.non2xx}`);
  console.log(`4xx / 5xx       ${result['4xx'] ?? 0} / ${result['5xx'] ?? 0}`);
  console.log(
    `probe           ${probe.status}${probeCode ? ` ${probeCode}: ${probeBody.error?.message ?? ''}` : ' OK'}`,
  );
  console.log('');
  console.log(
    `spatial index   ${usesIndex ? 'USED' : 'NOT USED'}${sequential ? ' (sequential scan on profiles!)' : ''}`,
  );
  console.log('');
  console.log(plan);
  /* eslint-enable no-console */

  const failures: string[] = [];

  if (probe.status === 429) {
    failures.push(
      'the endpoint is rate limiting — restart the API with RATE_LIMIT_GENERAL_MAX raised, or this measures the limiter rather than the deck',
    );
  } else if (result.non2xx > 0) {
    failures.push(
      `${result.non2xx} non-2xx responses — the endpoint is erroring under load (probe says ${probe.status} ${probeCode ?? ''})`,
    );
  }

  if (result.errors > 0) {
    failures.push(`${result.errors} connection errors`);
  }

  if (p99 > P99_CEILING_MS) {
    failures.push(`p99 ${p99}ms exceeds the ${P99_CEILING_MS}ms ceiling`);
  }

  if (sequential) {
    failures.push('the radius query is doing a sequential scan — the GIST index is missing');
  }

  if (failures.length > 0) {
    logger.error({ failures }, 'deck load test FAILED');
    process.exitCode = 1;
    return;
  }

  logger.info('deck load test passed');
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, 'deck load test errored');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
