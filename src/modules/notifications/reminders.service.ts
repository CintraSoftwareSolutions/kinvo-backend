import { MatchStatus, PlanStatus, prisma } from '@/db/prisma';
import { isBlockedBetween } from '@modules/safety/block.service';
import { logger } from '@utils/logger';
import { notify } from './notifications.service';

/**
 * Scheduled plan reminders (spec §7, Batch 11).
 *
 * Runs on a schedule rather than one timer per plan. A timer per plan would
 * have to survive restarts, redeploys, and every edit to the plan's time — a
 * sweep that asks "what starts soon and has not been reminded?" survives all
 * three for free.
 */

/** How far ahead of a plan the reminder goes out. */
const REMINDER_LEAD_MINUTES = 120;

/**
 * How far back the sweep looks.
 *
 * Wider than the interval between runs, so a run that is late or skipped does
 * not leave a hole where plans are silently never reminded. The
 * already-reminded check is what stops the overlap producing duplicates.
 */
const REMINDER_WINDOW_MINUTES = 90;

/**
 * True when this plan has already been reminded.
 *
 * The feed is the record, so it is also the idempotency key — no extra column,
 * and it stays correct if the sweep runs twice or a deploy overlaps two
 * workers.
 */
async function alreadyReminded(userId: string, planId: string): Promise<boolean> {
  const existing = await prisma.notification.findFirst({
    where: {
      user_id: userId,
      category: 'plan_update',
      data: { path: ['plan_id'], equals: planId },
      // Scoped to reminders specifically: a plan can legitimately produce other
      // plan_update notifications (proposed, confirmed, cancelled).
      title: { contains: 'Coming up' },
    },
    select: { id: true },
  });

  return existing !== null;
}

export async function sendPlanReminders(now = new Date()): Promise<number> {
  const from = new Date(now.getTime() + (REMINDER_LEAD_MINUTES - REMINDER_WINDOW_MINUTES) * 60_000);
  const to = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60_000);

  const plans = await prisma.plan.findMany({
    where: {
      status: PlanStatus.confirmed,
      scheduled_at: { gte: from, lte: to },
      // A plan on a dead match is not happening.
      match: { status: MatchStatus.active },
    },
    select: {
      id: true,
      scheduled_at: true,
      custom_location: true,
      venue: { select: { name: true } },
      match: { select: { user_a_id: true, user_b_id: true } },
    },
  });

  let sent = 0;

  for (const plan of plans) {
    const participants = [plan.match.user_a_id, plan.match.user_b_id];

    // Blocks beat everything, including a plan both people confirmed. Reminding
    // someone about a meeting with a person they have since blocked is the
    // worst possible notification this system could send.
    if (await isBlockedBetween(participants[0] as string, participants[1] as string)) {
      continue;
    }

    const where = plan.venue?.name ?? plan.custom_location ?? 'your plan';

    for (const userId of participants) {
      if (await alreadyReminded(userId, plan.id)) {
        continue;
      }

      await notify({
        userId,
        category: 'plan_update',
        title: 'Coming up soon',
        body: `${where} starts in about ${REMINDER_LEAD_MINUTES / 60} hours.`,
        data: { plan_id: plan.id, scheduled_at: plan.scheduled_at?.toISOString() ?? null },
      });

      sent += 1;
    }
  }

  if (sent > 0) {
    logger.info({ sent, plans: plans.length }, 'plan reminders sent');
  }

  return sent;
}

export { REMINDER_LEAD_MINUTES, REMINDER_WINDOW_MINUTES };
