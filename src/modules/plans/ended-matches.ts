import { PlanStatus, type Prisma } from '@/db/prisma';

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
