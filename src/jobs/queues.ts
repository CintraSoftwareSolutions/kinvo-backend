import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

import { env, isTest } from '@config/env';
import type { Mode } from '@/db/prisma';

/**
 * Background jobs (spec §3, Batch 7).
 *
 * BullMQ needs its own Redis connection: it uses blocking commands (BRPOPLPUSH)
 * that occupy a connection for their duration, so sharing the API's client
 * would stall every rate-limit and quota command behind a worker's poll.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ, not a preference — the
 * default causes blocking commands to error out mid-wait.
 */

export const QUEUE_NAMES = {
  DECK_GENERATION: 'deck-generation',
} as const;

export function jobConnection(): ConnectionOptions {
  return { url: env.REDIS_URL, maxRetriesPerRequest: null };
}

export interface DeckGenerationJob {
  user_id: string;
  mode: Mode;
}

let deckQueue: Queue<DeckGenerationJob> | null = null;

/**
 * Created lazily so importing this module never opens a connection. Tests
 * import the app, and a queue constructed at import time would connect to Redis
 * in every suite and hold the worker process open after the last test.
 */
export function getDeckQueue(): Queue<DeckGenerationJob> {
  if (!deckQueue) {
    deckQueue = new Queue<DeckGenerationJob>(QUEUE_NAMES.DECK_GENERATION, {
      connection: jobConnection(),
      defaultJobOptions: {
        // Deck generation is idempotent per (user, mode, day), so retrying is
        // always safe and never doubles a deck.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }

  return deckQueue;
}

export async function closeQueues(): Promise<void> {
  if (deckQueue) {
    await deckQueue.close();
    deckQueue = null;
  }
}

/** Jobs are never enqueued from tests — the lazy path in getDeck covers them. */
export function jobsEnabled(): boolean {
  return !isTest;
}
