import { Mode, PlanStatus, prisma } from '@/db/prisma';
import { sendPlanReminders } from '@modules/notifications/reminders.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { createBlock } from '../../helpers/factories';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';
import { matchPair } from '../../helpers/chat';

/**
 * Scheduled plan reminders (spec §7, Batch 11).
 *
 * The sweep asks "what starts soon and has not been reminded?" rather than
 * holding a timer per plan. A timer would have to survive restarts, redeploys,
 * and every edit to the plan's time; a sweep survives all three for free.
 */

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

async function createPlan(options: {
  matchId: string;
  creatorId: string;
  minutesFromNow: number;
  status?: PlanStatus;
}) {
  return prisma.plan.create({
    data: {
      match_id: options.matchId,
      creator_id: options.creatorId,
      status: options.status ?? PlanStatus.confirmed,
      scheduled_at: new Date(Date.now() + options.minutesFromNow * 60_000),
      custom_location: 'The ramen place',
    },
  });
}

describe('sendPlanReminders', () => {
  it('reminds both participants about a confirmed plan starting soon', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);
    await createPlan({ matchId: match_id, creatorId: a.user_id, minutesFromNow: 100 });

    const sent = await sendPlanReminders();

    expect(sent).toBe(2);

    for (const userId of [a.user_id, b.user_id]) {
      const reminders = await prisma.notification.findMany({
        where: { user_id: userId, category: 'plan_update', title: 'Coming up soon' },
      });

      expect(reminders).toHaveLength(1);
      expect(reminders[0]?.body).toContain('The ramen place');
    }
  });

  it('does not remind twice, even if the sweep runs again', async () => {
    const { a, match_id } = await matchPair(Mode.dating);
    await createPlan({ matchId: match_id, creatorId: a.user_id, minutesFromNow: 100 });

    await sendPlanReminders();
    const second = await sendPlanReminders();

    // The feed is the record, so it is also the idempotency key — no extra
    // column, and it stays correct if two workers overlap during a deploy.
    expect(second).toBe(0);
    expect(await prisma.notification.count({ where: { title: 'Coming up soon' } })).toBe(2);
  });

  it('ignores a plan too far out', async () => {
    const { a, match_id } = await matchPair(Mode.dating);
    await createPlan({ matchId: match_id, creatorId: a.user_id, minutesFromNow: 60 * 24 });

    expect(await sendPlanReminders()).toBe(0);
  });

  it('ignores a plan that has already started', async () => {
    const { a, match_id } = await matchPair(Mode.dating);
    await createPlan({ matchId: match_id, creatorId: a.user_id, minutesFromNow: -30 });

    expect(await sendPlanReminders()).toBe(0);
  });

  it('ignores a plan that is not confirmed', async () => {
    const { a, match_id } = await matchPair(Mode.dating);
    await createPlan({
      matchId: match_id,
      creatorId: a.user_id,
      minutesFromNow: 100,
      status: PlanStatus.proposed,
    });

    // A proposal nobody accepted is not happening.
    expect(await sendPlanReminders()).toBe(0);
  });

  it('never reminds about a plan with someone who has since been blocked', async () => {
    const { a, b, match_id } = await matchPair(Mode.dating);
    await createPlan({ matchId: match_id, creatorId: a.user_id, minutesFromNow: 100 });

    await createBlock(b.user_id, a.user_id);

    // Reminding someone about a meeting with a person they blocked is the worst
    // notification this system could send.
    expect(await sendPlanReminders()).toBe(0);
    expect(await prisma.notification.count({ where: { title: 'Coming up soon' } })).toBe(0);
  });

  it('ignores a plan whose match was unmatched', async () => {
    const { a, match_id } = await matchPair(Mode.dating);
    await createPlan({ matchId: match_id, creatorId: a.user_id, minutesFromNow: 100 });

    await prisma.match.update({
      where: { id: match_id },
      data: { status: 'unmatched', unmatched_at: new Date() },
    });

    expect(await sendPlanReminders()).toBe(0);
  });
});
