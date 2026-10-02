import { MatchStatus, PlanStatus, type Prisma, UserStatus, prisma } from '@/db/prisma';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { notify } from '@modules/notifications/notifications.service';
import { isBlockedBetween } from '@modules/safety/block.service';
import { otherUserId } from '@modules/matches/matches.service';
import { type ContactAlert, emailContacts } from '@modules/safety/contact-alerts';
import { type PlanForContact, planSharedEmail } from '@modules/safety/safety.emails';
import { onlineStatusFor } from '@/realtime/presence';
import { ApiError } from '@utils/api-error';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';

const PLAN_INCLUDE = {
  venue: { select: { id: true, name: true, category: true, address: true, city: true } },
  match: {
    select: {
      id: true,
      mode: true,
      user_a_id: true,
      user_b_id: true,
      status: true,
      user_a: { select: USER_COMPACT_SELECT },
      user_b: { select: USER_COMPACT_SELECT },
    },
  },
  shares: { select: { id: true, trusted_contact: { select: { user_id: true } } } },
} satisfies Prisma.PlanInclude;

type PlanRow = Prisma.PlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

export interface PlanView {
  id: string;
  match_id: string;
  mode: string;
  user: UserCompact;
  status: PlanStatus;
  scheduled_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
  venue: { id: string; name: string; category: string; address: string | null } | null;
  custom_location: string | null;
  custom_address: string | null;
  is_mine: boolean;
  awaiting_my_response: boolean;
  shared_with_contacts: number;
  created_at: string;
}

interface OtherPeople {
  photoUrls: Map<string, string>;
  online: Set<string>;
}

function toView(plan: PlanRow, viewerId: string, people: OtherPeople, now: Date): PlanView {
  const isMine = plan.creator_id === viewerId;
  const other = plan.match.user_a_id === viewerId ? plan.match.user_b : plan.match.user_a;
  const timeHasPassed = plan.scheduled_at !== null && plan.scheduled_at <= now;

  return {
    id: plan.id,
    match_id: plan.match_id,
    mode: plan.match.mode,
    user: toUserCompact(other, people.photoUrls.get(other.id) ?? null, people.online.has(other.id)),
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
    awaiting_my_response: plan.status === PlanStatus.proposed && !isMine && !timeHasPassed,
    shared_with_contacts: plan.shares.filter((share) => share.trusted_contact.user_id === viewerId)
      .length,
    created_at: plan.created_at.toISOString(),
  };
}

async function present(plans: PlanRow[], viewerId: string): Promise<PlanView[]> {
  const others = [...new Set(plans.map((plan) => otherUserId(plan.match, viewerId)))];
  const [photoUrls, online] = await Promise.all([
    getPrimaryPhotoUrlsFor(others),
    onlineStatusFor(others),
  ]);
  const now = new Date();

  return plans.map((plan) => toView(plan, viewerId, { photoUrls, online }, now));
}

async function presentOne(plan: PlanRow, viewerId: string): Promise<PlanView> {
  const [view] = await present([plan], viewerId);

  if (!view) {
    throw new Error('Presenting one plan produced no view.');
  }

  return view;
}

const BOTH_ACCOUNTS_ACTIVE = {
  user_a: { deleted_at: null, status: UserStatus.active },
  user_b: { deleted_at: null, status: UserStatus.active },
} satisfies Prisma.MatchWhereInput;

async function loadVisible(viewerId: string, planId: string): Promise<PlanRow> {
  const plan = await prisma.plan.findFirst({
    where: {
      id: planId,
      match: { OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }], ...BOTH_ACCOUNTS_ACTIVE },
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
    await assertVenueAvailable(input.venue_id);
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

  return presentOne(plan, viewerId);
}

async function assertVenueAvailable(venueId: string): Promise<void> {
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, is_active: true },
    select: { id: true },
  });

  if (!venue) {
    throw ApiError.notFound('That venue is not available.');
  }
}

function placeOf(plan: PlanRow): string {
  return plan.venue?.name ?? plan.custom_location ?? 'somewhere';
}

async function notifyProposed(plan: PlanRow, recipientId: string): Promise<void> {
  const where = placeOf(plan);

  await notify({
    userId: recipientId,
    category: 'plan_update',
    title: 'New plan suggested',
    body: `${where}${plan.scheduled_at ? '' : ''} — tap to accept or decline.`,
    data: { plan_id: plan.id, match_id: plan.match_id },
  });
}

export interface UpdatePlanInput {
  venue_id?: string | null;
  custom_location?: string | null;
  custom_address?: string | null;
  scheduled_at?: string;
  duration_minutes?: number;
  notes?: string;
}

export async function updatePlan(
  viewerId: string,
  planId: string,
  input: UpdatePlanInput,
): Promise<PlanView> {
  const existing = await loadVisible(viewerId, planId);

  if (existing.creator_id !== viewerId) {
    throw ApiError.notFound();
  }

  if (existing.status !== PlanStatus.draft && existing.status !== PlanStatus.proposed) {
    throw ApiError.badRequest('This plan can no longer be changed.', {
      status: existing.status,
    });
  }

  const { otherUserId: recipientId } = await assertCanPlan(viewerId, existing.match_id);

  if (input.venue_id) {
    await assertVenueAvailable(input.venue_id);
  }

  const venueId = input.venue_id === undefined ? existing.venue_id : input.venue_id;
  const customLocation =
    input.custom_location === undefined ? existing.custom_location : input.custom_location;

  if (!venueId && !customLocation) {
    throw ApiError.validation({ venue_id: ['Choose a venue or give a location.'] });
  }

  const scheduledAt =
    input.scheduled_at === undefined ? existing.scheduled_at : new Date(input.scheduled_at);

  if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
    throw ApiError.validation({ scheduled_at: ['Pick a time in the future.'] });
  }

  const updated = await prisma.plan.update({
    where: { id: planId },
    data: {
      venue_id: venueId,
      custom_location: customLocation,
      ...(input.custom_address === undefined
        ? {}
        : { custom_address: input.custom_address || null }),
      ...(input.scheduled_at === undefined ? {} : { scheduled_at: scheduledAt }),
      ...(input.duration_minutes === undefined ? {} : { duration_minutes: input.duration_minutes }),
      ...(input.notes === undefined ? {} : { notes: input.notes || null }),
    },
    include: PLAN_INCLUDE,
  });

  // The other person may already have read this proposal. Changing it quietly
  // would have them answer a plan they haven't seen.
  if (existing.status === PlanStatus.proposed) {
    await notify({
      userId: recipientId,
      category: 'plan_update',
      title: 'Plan changed',
      body: `${placeOf(updated)} — take another look before you answer.`,
      data: { plan_id: updated.id, match_id: updated.match_id },
    });
  }

  return presentOne(updated, viewerId);
}

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

  // A draft saved for this afternoon may be sent tomorrow.
  if (existing.scheduled_at.getTime() <= Date.now()) {
    throw ApiError.validation({ scheduled_at: ['Pick a time in the future.'] });
  }

  const { otherUserId: recipientId } = await assertCanPlan(viewerId, existing.match_id);

  const updated = await prisma.plan.update({
    where: { id: planId },
    data: { status: PlanStatus.proposed },
    include: PLAN_INCLUDE,
  });

  await notifyProposed(updated, recipientId);

  return presentOne(updated, viewerId);
}

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

  // Accepting a proposal nobody answered in time would confirm a meeting in
  // the past. Declining one is still fine.
  if (accept && existing.scheduled_at && existing.scheduled_at.getTime() <= Date.now()) {
    throw ApiError.badRequest('The time for that plan has passed.', { status: existing.status });
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

  return presentOne(updated, viewerId);
}

export async function cancelPlan(
  viewerId: string,
  planId: string,
  reason?: string,
): Promise<PlanView> {
  const existing = await loadVisible(viewerId, planId);

  if (existing.status === PlanStatus.draft) {
    throw ApiError.badRequest('That plan was never sent. Delete the draft instead.', {
      status: existing.status,
    });
  }

  if (
    existing.status === PlanStatus.completed ||
    existing.status === PlanStatus.cancelled ||
    existing.status === PlanStatus.declined
  ) {
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

  await notify({
    userId: other,
    category: 'plan_update',
    title: 'Plan cancelled',
    body: reason ?? 'The plan was cancelled.',
    data: { plan_id: updated.id, match_id: updated.match_id },
  });

  return presentOne(updated, viewerId);
}

export async function deleteDraft(viewerId: string, planId: string): Promise<void> {
  const existing = await loadVisible(viewerId, planId);

  if (existing.status !== PlanStatus.draft) {
    throw ApiError.badRequest('Only a draft can be deleted. Cancel a plan that was sent.', {
      status: existing.status,
    });
  }

  // Conditional, so a draft proposed a moment ago in another request is never
  // deleted after the other person was told about it.
  const { count } = await prisma.plan.deleteMany({
    where: { id: planId, creator_id: viewerId, status: PlanStatus.draft },
  });

  if (count === 0) {
    throw ApiError.notFound();
  }

  logger.info({ plan_id: planId }, 'draft plan deleted');
}

export type PlanTab = 'upcoming' | 'pending' | 'history';

export async function listPlans(
  viewerId: string,
  options: { limit: number; cursor?: string; tab?: PlanTab; drafts?: boolean },
) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const now = new Date();

  // A proposal whose time passed without an answer can no longer be accepted,
  // so it is history, like a confirmed plan whose time has passed.
  const tabFilter: Prisma.PlanWhereInput = options.drafts
    ? { status: PlanStatus.draft, creator_id: viewerId }
    : options.tab === 'upcoming'
      ? { status: PlanStatus.confirmed, scheduled_at: { gte: now } }
      : options.tab === 'pending'
        ? { status: PlanStatus.proposed, scheduled_at: { gte: now } }
        : options.tab === 'history'
          ? {
              OR: [
                {
                  status: { in: [PlanStatus.completed, PlanStatus.cancelled, PlanStatus.declined] },
                },
                {
                  status: { in: [PlanStatus.confirmed, PlanStatus.proposed] },
                  scheduled_at: { lt: now },
                },
              ],
            }
          : { status: { not: PlanStatus.draft } };

  const rows = await prisma.plan.findMany({
    where: {
      AND: [
        {
          match: {
            OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
            ...BOTH_ACCOUNTS_ACTIVE,
          },
        },
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
    plans: await present(page.items, viewerId),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export async function getPlan(viewerId: string, planId: string): Promise<PlanView> {
  return presentOne(await loadVisible(viewerId, planId), viewerId);
}

export interface ShareResult {
  shared: number;
  contacts: ContactAlert[];
}

export async function sharePlan(
  viewerId: string,
  planId: string,
  contactIds: string[],
  utcOffsetMinutes?: number,
): Promise<ShareResult> {
  const plan = await loadVisible(viewerId, planId);

  if (plan.status !== PlanStatus.confirmed) {
    throw ApiError.badRequest('Only a confirmed plan can be shared.', { status: plan.status });
  }

  const requested = [...new Set(contactIds)];
  const contacts = await prisma.trustedContact.findMany({
    where: { id: { in: requested }, user_id: viewerId },
    select: { id: true, name: true, email: true },
  });

  // Silently ignoring an id that is not yours would make it impossible to tell
  // a typo from a contact that was deleted.
  if (contacts.length !== requested.length) {
    throw ApiError.notFound('One of those contacts does not exist.');
  }

  const alreadyTold = new Set(
    (
      await prisma.planShare.findMany({
        where: { plan_id: planId, trusted_contact_id: { in: requested } },
        select: { trusted_contact_id: true },
      })
    ).map((share) => share.trusted_contact_id),
  );

  const sender = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { display_name: true },
  });
  const other = plan.match.user_a_id === viewerId ? plan.match.user_b : plan.match.user_a;
  const details: PlanForContact = {
    withName: other.display_name,
    place: placeOf(plan),
    address: plan.venue?.address ?? plan.custom_address,
    at: plan.scheduled_at,
    durationMinutes: plan.duration_minutes,
  };

  const alerts = await emailContacts(
    contacts.filter((contact) => !alreadyTold.has(contact.id)),
    (contact) =>
      planSharedEmail({
        to: contact.email,
        contactName: contact.name,
        senderName: sender?.display_name ?? 'Someone you know',
        plan: details,
        utcOffsetMinutes,
      }),
  );

  const emailed = alerts.filter((alert) => alert.delivery === 'emailed');
  if (emailed.length > 0) {
    await prisma.planShare.createMany({
      data: emailed.map((alert) => ({ plan_id: planId, trusted_contact_id: alert.id })),
      skipDuplicates: true,
    });
  }

  const shared = await prisma.planShare.count({
    where: { plan_id: planId, trusted_contact: { user_id: viewerId } },
  });

  logger.info({ plan_id: planId, emailed: emailed.length }, 'plan shared with trusted contacts');

  return {
    shared,
    contacts: [
      ...alerts,
      ...contacts
        .filter((contact) => alreadyTold.has(contact.id))
        .map((contact) => ({
          id: contact.id,
          name: contact.name,
          delivery: 'already_told' as const,
        })),
    ],
  };
}

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
