import { Queue } from 'bullmq';

import { logger } from '@utils/logger';
import { QUEUE_NAMES, closeQueues, jobConnection, jobsEnabled } from './queues';
import {
  REMINDER_JOB_NAME,
  SCHEDULER_JOB_NAME,
  enqueueDailyDecks,
  startDeckWorker,
  stopDeckWorker,
} from './deck.worker';

/**
 * Job lifecycle, owned by server.ts.
 *
 * Nothing starts on import: tests import the Express app and must not open
 * BullMQ connections or run workers.
 */

let scheduler: Queue | null = null;

/**
 * Deck generation is scheduled just after UTC midnight, the same boundary daily
 * quotas reset on. Rolling the deck and the allowance at different times would
 * hand someone a fresh deck they have no swipes left for.
 */
const DAILY_DECK_CRON = '10 0 * * *';

/**
 * Plan reminders run every half hour, not daily.
 *
 * The reminder goes out two hours before a plan starts, so a daily sweep would
 * miss anything booked in the morning for that evening — which is most plans.
 * The sweep window is wider than this interval, so a skipped run leaves no gap.
 */
const PLAN_REMINDER_CRON = '*/30 * * * *';

export async function startJobs(): Promise<void> {
  if (!jobsEnabled()) {
    return;
  }

  startDeckWorker();

  scheduler = new Queue(QUEUE_NAMES.DECK_GENERATION, { connection: jobConnection() });

  await scheduler.upsertJobScheduler(
    'daily-decks',
    { pattern: DAILY_DECK_CRON, tz: 'UTC' },
    { name: SCHEDULER_JOB_NAME, data: {} },
  );

  await scheduler.upsertJobScheduler(
    'plan-reminders',
    { pattern: PLAN_REMINDER_CRON, tz: 'UTC' },
    { name: REMINDER_JOB_NAME, data: {} },
  );

  logger.info({ decks: DAILY_DECK_CRON, reminders: PLAN_REMINDER_CRON }, 'jobs started');
}

export async function stopJobs(): Promise<void> {
  await stopDeckWorker();

  if (scheduler) {
    await scheduler.close();
    scheduler = null;
  }

  await closeQueues();
}

export { enqueueDailyDecks };
