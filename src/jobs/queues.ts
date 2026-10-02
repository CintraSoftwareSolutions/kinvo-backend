import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

import { env, isTest } from '@config/env';
import type { Mode } from '@/db/prisma';

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

export function getDeckQueue(): Queue<DeckGenerationJob> {
  if (!deckQueue) {
    deckQueue = new Queue<DeckGenerationJob>(QUEUE_NAMES.DECK_GENERATION, {
      connection: jobConnection(),
      defaultJobOptions: {
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

export function jobsEnabled(): boolean {
  return !isTest;
}
