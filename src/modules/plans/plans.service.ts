import { MatchStatus, PlanStatus, type Prisma, prisma } from '@/db/prisma';
import { notify } from '@modules/notifications/notifications.service';
import { isBlockedBetween } from '@modules/safety/block.service';
import { otherUserId } from '@modules/matches/matches.service';
import { ApiError } from '@utils/api-error';
import { decodeCursor, paginate } from '@utils/cursor';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';

/**
 * Plans (spec §5.8, Batch 12).
 *
 * Lifecycle: draft → proposed → confirmed | declined | cancelled → completed.
 *
 * THE RULE THAT SHAPES VISIBILITY: a draft is visible ONLY to its creator. The
 * other person sees nothing until it is proposed. Someone sketching out an idea
 * they might not send must not have it appear on the other person's screen —
 * that is the difference between a draft and a message.
 */

const PLAN_INCLUDE = {
  venue: { select: { id: true, name: true, category: true, address: true, city: true } },
  match: { select: { id: true, mode: true, user_a_id: true, user_b_id: true, status: true } },
  shares: { select: { id: true, trusted_contact_id: true } },
} satisfies Prisma.PlanInclude;

type PlanRow = Prisma.PlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

export interface PlanView {
  id: string;
  match_id: string;
  mode: string;
  status: PlanStatus;
  scheduled_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
  venue: { id: string; name: string; category: string; address: string | null } | null;
  custom_location: string | null;
  custom_address: string | null;
  /** True when the caller created it — the app renders a different screen. */
  is_mine: boolean;
  /** True when it is the caller's turn to respond. */
  awaiting_my_response: boolean;
  shared_with_contacts: number;
  created_at: string;
}

function toView(plan: PlanRow, viewerId: string): PlanView {
  const isMine = plan.creator_id === viewerId;

  return {
    id: plan.id,
    match_id: plan.match_id,
    mode: plan.match.mode,
    status: plan.status,
    scheduled_at: plan.scheduled_at?.toISOString() ?? null,
    duration_minutes: plan.duration_minutes,
    notes: plan.notes,
    venue: plan.venue
      ? {
          id: plan.venue.id,
          name: plan.venue.name,
          category: plan.venue.category,
          address: plan.venue.address,
        }
      : null,
    custom_location: plan.custom_location,
    custom_address: plan.custom_address,
    is_mine: isMine,
    awaiting_my_response: plan.status === PlanStatus.proposed && !isMine,
    shared_with_contacts: plan.shares.length,
    created_at: plan.created_at.toISOString(),
  };
}

/**
 * Loads a plan the caller can see.
 *
 * Drafts are filtered to the creator here rather than in each caller — putting
 * it in one place is what stops a future endpoint forgetting and leaking one.
 */
async function loadVisible(viewerId: string, planId: string): Promise<PlanRow> {
  const plan = await prisma.plan.findFirst({
    where: {
      id: planId,
      match: { OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }] },
      // spec §5.8: a draft is visible only to its creator.
      OR: [{ status: { not: PlanStatus.draft } }, { creator_id: viewerId }],
    },
    include: PLAN_INCLUDE,
  });

  if (!plan) {
    throw ApiError.notFound();
  }

  return plan;
}

/**
 * Confirms the pair may still plan together.
 *
 * spec §5.8: only participants in an ACTIVE, NON-BLOCKED match. Checked on
 * every mutation rather than only at creation, because a match can be blocked
 * or unmatched between drafting a plan and proposing it.
 */
async function assertCanPlan(viewerId: string, matchId: string) {
  const match = await prisma.match.findFirst({
    where: {
      id: matchId,
      status: MatchStatus.active,
      expires_at: { gt: new Date() },
      OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
    },
    select: { id: true, user_a_id: true, user_b_id: true, mode: true },
  });

  if (!match) {
    throw ApiError.notFound();
  }

  const other = otherUserId(match, viewerId);

  if (await isBlockedBetween(viewerId, other)) {
    // Same shape as a closed conversation: one error for every reason, so a
    // block cannot be told apart from an expiry.
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'This conversation is closed.', {
      is_writable: false,
    });
  }

  return { match, otherUserId: other };
}

export interface CreatePlanInput {
  match_id: string;
  venue_id?: string;
  custom_location?: string;
  custom_address?: string;
  scheduled_at?: string;
  duration_minutes?: number;
  notes?: string;
  /** False keeps it a draft, visible only to the creator. */
  propose?: boolean;
}

export async function createPlan(viewerId: string, input: CreatePlanInput): Promise<PlanView> {
  const { match, otherUserId: recipientId } = await assertCanPlan(viewerId, input.match_id);

  if (!input.venue_id && !input.custom_location) {
    throw ApiError.validation({
      venue_id: ['Choose a venue or give a location.'],
    });
  }

  if (input.venue_id) {
    const venue = await prisma.venue.findFirst({
      where: { id: input.venue_id, is_active: true },
      select: { id: true },
    });

    if (!venue) {
      throw ApiError.notFound('That venue is not available.');
    }
  }

  // Proposing without a time is meaningless — the other person cannot answer
  // "yes" to an unscheduled plan. A draft may legitimately have none yet.
  if (input.propose && !input.scheduled_at) {
    throw ApiError.validation({ scheduled_at: ['Set a time before proposing a plan.'] });
  }

  const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : null;

  if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
    throw ApiError.validation({ scheduled_at: ['Pick a time in the future.'] });
  }

  const plan = await prisma.plan.create({
    data: {
      match_id: input.match_id,
      creator_id: viewerId,
      venue_id: input.venue_id ?? null,
      custom_location: input.custom_location ?? null,
      custom_address: input.custom_address ?? null,
      scheduled_at: scheduledAt,
      duration_minutes: input.duration_minutes ?? null,
      notes: input.notes ?? null,
      status: input.propose ? PlanStatus.proposed : PlanStatus.draft,
    },
    include: PLAN_INCLUDE,
  });

  // Only a proposal is announced. Notifying on a draft would defeat the point
  // of drafts entirely.
  if (input.propose) {
    await notifyProposed(plan, recipientId);
  }

  logger.info(
    { plan_id: plan.id, mode: match.mode, proposed: Boolean(input.propose) },
    'plan created',
  );

  return toView(plan, viewerId);
}

async function notifyProposed(plan: PlanRow, recipientId: string): Promise<void> {
  const where = plan.venue?.name ?? plan.custom_location ?? 'somewhere';

  await notify({
    userId: recipientId,
    category: 'plan_update',
    title: 'New plan suggested',
    body: `${where}${plan.scheduled_at ? '' : ''} — tap to accept or decline.`,
    data: { plan_id: plan.id, match_id: plan.match_id },
  });
}

export async function updatePlan(
  viewerId: string,
  planId: string,
  input: Partial<CreatePlanInput>,
): Promise<PlanView> {
  const existing = await loadVisible(viewerId, planId);

  if (existing.creator_id !== viewerId) {
    // Editing someone else's proposal would let one side change the time after
    // the other accepted it.
    throw ApiError.notFound();
  }

  if (existing.status !== PlanStatus.draft && existing.status !== PlanStatus.proposed) {
    throw ApiError.badRequest('This plan can no longer be changed.', {
      status: existing.status,
    });
  }

  await assertCanPlan(viewerId, existing.match_id);

  const scheduledAt =
    input.scheduled_at === undefined ? existing.scheduled_at : new Date(input.scheduled_at);

  if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
    throw ApiError.validation({ scheduled_at: ['Pick a time in the future.'] });
  }

  const updated = await prisma.plan.update({
    where: { id: planId },
    data: {
      ...(input.venue_id === undefined ? {} : { venue_id: input.venue_id || null }),
      ...(input.custom_location === undefined
        ? {}
        : { custom_location: input.custom_location || null }),
      ...(input.custom_address === undefined
        ? {}
        : { custom_address: input.custom_address || null }),
      ...(input.scheduled_at === undefined ? {} : { scheduled_at: scheduledAt }),
      ...(input.duration_minutes === undefined ? {} : { duration_minutes: input.duration_minutes }),
      ...(input.notes === undefined ? {} : { notes: input.notes || null }),
    },
    include: PLAN_INCLUDE,
  });

  return toView(updated, viewerId);
}

/** Moves a draft to proposed. The only way the other side learns it exists. */
export async function proposePlan(viewerId: string, planId: string): Promise<PlanView> {
  const existing = await loadVisible(viewerId, planId);

  if (existing.creator_id !== viewerId) {
    throw ApiError.notFound();
  }

  if (existing.status !== PlanStatus.draft) {
    throw ApiError.badRequest('That plan has already been sent.', { status: existing.status });
  }

  if (!existing.scheduled_at) {
    throw ApiError.validation({ scheduled_at: ['Set a time before proposing a plan.'] });
  }

  const { otherUserId: recipientId } = await assertCanPlan(viewerId, existing.match_id);

  const updated = await prisma.plan.update({
    where: { id: planId },
    data: { status: PlanStatus.proposed },
    include: PLAN_INCLUDE,
  });

  await notifyProposed(updated, recipientId);

  return toView(updated, viewerId);
}

/**
 * Accept or decline. Only the person who did NOT propose it may respond.
 *
 * Otherwise someone could accept their own plan and produce a confirmed
 * meeting the other person never agreed to.
 */
export async function respondToPlan(
  viewerId: string,
  planId: string,
  accept: boolean,
): Promise<PlanView> {
  const existing = await loadVisible(viewerId, planId);

  if (existing.status !== PlanStatus.proposed) {
    throw ApiError.badRequest('That plan is not awaiting a response.', {
      status: existing.status,
    });
  }

  if (existing.creator_id === viewerId) {
    throw ApiError.badRequest('You cannot respond to your own plan.');
  }

  const { otherUserId: proposerId } = await assertCanPlan(viewerId, existing.match_id);

  const updated = await prisma.plan.update({
    where: { id: planId },
    data: {
      status: accept ? PlanStatus.confirmed : PlanStatus.declined,
      responded_at: new Date(),
      responded_by_id: viewerId,
    },
    include: PLAN_INCLUDE,
  });

  await notify({
    userId: proposerId,
    category: 'plan_update',
    title: accept ? 'Plan confirmed' : 'Plan declined',
    body: accept
      ? `${updated.venue?.name ?? updated.custom_location ?? 'Your plan'} is on.`
      : 'Your plan was declined.',
    data: { plan_id: updated.id, match_id: updated.match_id },
  });

  return toView(updated, viewerId);
}

/** Either participant may cancel, at any point before completion. */
export async function cancelPlan(
  viewerId: string,
  planId: string,
  reason?: string,
): Promise<PlanView> {
  const existing = await loadVisible(viewerId, planId);

  if (existing.status === PlanStatus.completed || existing.status === PlanStatus.cancelled) {
    throw ApiError.badRequest('That plan is already finished.', { status: existing.status });
  }

  const other = otherUserId(existing.match, viewerId);

  const updated = await prisma.plan.update({
    where: { id: planId },
    data: {
      status: PlanStatus.cancelled,
      cancelled_at: new Date(),
      cancelled_by_id: viewerId,
      cancellation_reason: reason ?? null,
    },
    include: PLAN_INCLUDE,
  });

  // Only tell the other person about a plan they could see. Cancelling a draft
  // would otherwise announce a plan that was never sent.
  if (existing.status !== PlanStatus.draft) {
    await notify({
      userId: other,
      category: 'plan_update',
      title: 'Plan cancelled',
      body: reason ?? 'The plan was cancelled.',
      data: { plan_id: updated.id, match_id: updated.match_id },
    });
  }

  return toView(updated, viewerId);
}

export type PlanTab = 'upcoming' | 'pending' | 'history';

/**
 * The three tabs from spec §5.8, plus drafts.
 *
 * Drafts are deliberately their own filter rather than living in "pending":
 * pending means waiting on the other person, and a draft is waiting on you.
 */
export async function listPlans(
  viewerId: string,
  options: { limit: number; cursor?: string; tab?: PlanTab; drafts?: boolean },
) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const now = new Date();

  const tabFilter: Prisma.PlanWhereInput = options.drafts
    ? { status: PlanStatus.draft, creator_id: viewerId }
    : options.tab === 'upcoming'
      ? { status: PlanStatus.confirmed, scheduled_at: { gte: now } }
      : options.tab === 'pending'
        ? { status: PlanStatus.proposed }
        : options.tab === 'history'
          ? {
              OR: [
                {
                  status: { in: [PlanStatus.completed, PlanStatus.cancelled, PlanStatus.declined] },
                },
                { status: PlanStatus.confirmed, scheduled_at: { lt: now } },
              ],
            }
          : { status: { not: PlanStatus.draft } };

  const rows = await prisma.plan.findMany({
    where: {
      AND: [
        { match: { OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }] } },
        // A draft never leaks, whichever tab is asked for.
        { OR: [{ status: { not: PlanStatus.draft } }, { creator_id: viewerId }] },
        tabFilter,
        ...(after ? [{ created_at: { lt: new Date(String(after.k)) } }] : []),
      ],
    },
    include: PLAN_INCLUDE,
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  return {
    plans: page.items.map((plan) => toView(plan, viewerId)),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export async function getPlan(viewerId: string, planId: string): Promise<PlanView> {
  return toView(await loadVisible(viewerId, planId), viewerId);
}

/**
 * Shares a plan with the caller's trusted contacts (spec §5.7).
 *
 * Only a CONFIRMED plan can be shared. Telling someone's sister about a plan
 * that was never accepted is noise, and it leaks the other person's
 * availability before they agreed to anything.
 */
export async function sharePlan(
  viewerId: string,
  planId: string,
  contactIds: string[],
): Promise<{ shared: number }> {
  const plan = await loadVisible(viewerId, planId);

  if (plan.status !== PlanStatus.confirmed) {
    throw ApiError.badRequest('Only a confirmed plan can be shared.', { status: plan.status });
  }

  const contacts = await prisma.trustedContact.findMany({
    where: { id: { in: contactIds }, user_id: viewerId },
    select: { id: true },
  });

  // Silently ignoring an id that is not yours would make it impossible to tell
  // a typo from a contact that was deleted.
  if (contacts.length !== contactIds.length) {
    throw ApiError.notFound('One of those contacts does not exist.');
  }

  await prisma.planShare.createMany({
    data: contacts.map((contact) => ({ plan_id: planId, trusted_contact_id: contact.id })),
    skipDuplicates: true,
  });

  logger.info({ plan_id: planId, count: contacts.length }, 'plan shared with trusted contacts');

  return { shared: contacts.length };
}

/**
 * Marks plans that have passed as completed.
 *
 * Bookkeeping, like the match sweep: the History tab already treats a confirmed
 * plan in the past as history, so this job being late changes nothing a user
 * sees.
 */
export async function sweepCompletedPlans(now: Date = new Date()): Promise<number> {
  const result = await prisma.plan.updateMany({
    where: {
      status: PlanStatus.confirmed,
      scheduled_at: { lt: new Date(now.getTime() - 4 * 60 * 60 * 1000) },
    },
    data: { status: PlanStatus.completed, completed_at: now },
  });

  return result.count;
}
