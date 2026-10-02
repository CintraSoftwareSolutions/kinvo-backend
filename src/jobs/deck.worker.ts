import { Worker } from 'bullmq';

import { ALL_MODES } from '@modules/modes/modes.service';
import { generateDeck, usersNeedingDecks } from '@modules/discovery/deck.service';
import { sweepExpiredMatches } from '@modules/matches/matches.service';
import { sendPlanReminders } from '@modules/notifications/reminders.service';
import { sweepLiveLocations } from '@modules/safety/location.service';
import { sweepRingingCalls, sweepStuckCalls } from '@modules/calls/calls.service';
import { sweepCompletedPlans } from '@modules/plans/plans.service';
import { sweepExpiredSubscriptions } from '@modules/subscriptions/subscriptions.service';
import { logger } from '@utils/logger';
import { QUEUE_NAMES, type DeckGenerationJob, getDeckQueue, jobConnection } from './queues';

export const SCHEDULER_JOB_NAME = 'enqueue-daily-decks';

export const REMINDER_JOB_NAME = 'send-plan-reminders';

let worker: Worker<DeckGenerationJob> | null = null;

export function startDeckWorker(): Worker<DeckGenerationJob> {
  if (worker) {
    return worker;
  }

  worker = new Worker<DeckGenerationJob>(
    QUEUE_NAMES.DECK_GENERATION,
    async (job) => {
      if (job.name === REMINDER_JOB_NAME) {
        const [reminded, trails, completed, rungOut, abandoned] = await Promise.all([
          sendPlanReminders(),
          sweepLiveLocations(),
          sweepCompletedPlans(),
          sweepRingingCalls(),
          sweepStuckCalls(),
        ]);

        return {
          reminded,
          trails_pruned: trails,
          plans_completed: completed,
          calls_missed: rungOut,
          calls_abandoned: abandoned,
        };
      }

      if (job.name === SCHEDULER_JOB_NAME) {
        const [enqueued, expired, lapsed] = await Promise.all([
          enqueueDailyDecks(),
          sweepExpiredMatches(),
          sweepExpiredSubscriptions(),
        ]);

        return { enqueued, expired, lapsed_subscriptions: lapsed };
      }

      const { user_id, mode } = job.data;
      return generateDeck(user_id, mode);
    },
    {
      connection: jobConnection(),
      concurrency: 4,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ err: error, job_id: job?.id, data: job?.data }, 'deck generation failed');
  });

  return worker;
}

export async function stopDeckWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
export async function enqueueDailyDecks(now: Date = new Date()): Promise<number> {
  const queue = getDeckQueue();
  const day = now.toISOString().slice(0, 10);
  let enqueued = 0;

  for (const mode of ALL_MODES) {
    const userIds = await usersNeedingDecks(mode);

    if (userIds.length === 0) {
      continue;
    }

    await queue.addBulk(
      userIds.map((user_id) => ({
        name: 'generate',
        data: { user_id, mode },
        opts: { jobId: `${user_id}:${mode}:${day}` },
      })),
    );

    enqueued += userIds.length;
  }

  logger.info({ enqueued, day }, 'daily decks enqueued');

  return enqueued;
}
