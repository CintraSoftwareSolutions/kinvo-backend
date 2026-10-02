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


let scheduler: Queue | null = null;

const DAILY_DECK_CRON = '10 0 * * *';

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
