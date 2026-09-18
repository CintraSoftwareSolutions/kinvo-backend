import { PlanStatus, type Prisma } from '@/db/prisma';

/**
 * Closes the plans on matches that have just ended, inside the transaction
 * that ends them (unmatch, block).
 *
 * A plan with someone the user can no longer reach is not happening, and
 * leaving it under Upcoming or Pending says it is. Drafts are deleted rather
 * than cancelled: a cancelled plan is visible to both people, and a draft was
 * never shown to the other one. Plans already in the past are left to the
 * completion sweep.
 *
 * Nobody is notified. The match ending is the news, and a "plan cancelled"
 * push straight after a block would hint at the block (spec §5.5).
 *
 * Kept apart from the plans service so the matches and blocks services can
 * call it without an import cycle.
 */
export async function closePlansOnEndedMatches(
  tx: Prisma.TransactionClient,
  matches: Prisma.MatchWhereInput,
  endedById: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.plan.deleteMany({ where: { status: PlanStatus.draft, match: matches } });

  await tx.plan.updateMany({
    where: {
      match: matches,
      OR: [
        { status: PlanStatus.proposed },
        { status: PlanStatus.confirmed, scheduled_at: { gte: now } },
      ],
    },
    data: { status: PlanStatus.cancelled, cancelled_at: now, cancelled_by_id: endedById },
  });
}
