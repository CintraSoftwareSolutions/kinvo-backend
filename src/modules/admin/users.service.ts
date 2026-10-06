import {
  type Mode,
  type Prisma,
  SubscriptionStatus,
  SubscriptionTier,
  UserRole,
  UserStatus,
  prisma,
} from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { decodeCursor, paginate } from '@utils/cursor';
import { ERROR_CODES } from '@utils/error-codes';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { resolveTier } from '@modules/subscriptions/subscriptions.service';
import { logger } from '@utils/logger';
import { writeAudit } from './admin.service';
import {
  type ActivityState,
  type RiskLevel,
  NO_RISK_SIGNALS,
  activityState,
  riskLevel,
  riskSignalsFor,
  scoreRisk,
} from './risk';

/**
 * User management for the admin panel (Batch 15).
 *
 * THE DISPLAY STATUS PROBLEM, and why this returns more than the panel asks
 * for. The panel renders one `status` field with four values — Active, Premium,
 * Inactive, Flagged — which conflates three independent things: whether the
 * account is usable, what it pays for, and whether moderation is looking at it.
 * An account can be suspended AND premium AND flagged at once.
 *
 * Collapsing them in the API would make the backend lie, and the lie would be
 * permanent: once the panel reads `status === 'Premium'` there is no way to ask
 * "is this account suspended" again. So each is returned on its own, AND a
 * `display_status` is computed to the panel's four values so it works unchanged.
 * The panel can move to the honest fields whenever it likes.
 *
 * NOTHING HERE CHANGES AN APP ENDPOINT. Suspension writes the same columns
 * `authenticate` already reads, so a suspended account stops working on its
 * next request — no new mechanism, and nothing for the app to learn.
 */

/** The panel's four-value union, derived rather than stored. */
export type DisplayStatus = 'Active' | 'Premium' | 'Inactive' | 'Flagged';

/** Inactive past this long. Matches what "last active" means to an operator. */
const INACTIVE_AFTER_DAYS = 30;

export interface AdminUserRow {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  joinDate: string;
  lastActive: string;
  /** The panel's single field, derived from the three below. */
  status: DisplayStatus;
  plan: string;
  mode: string;
  risk: RiskLevel;

  /** The honest fields. Prefer these over `status` and `plan`. */
  account_status: UserStatus;
  tier: SubscriptionTier;
  is_flagged: boolean;
  is_verified: boolean;
  staff_role: UserRole;
  risk_score: number;
  suspended_at: string | null;
  suspension_reason: string | null;
}

const USER_SELECT = {
  id: true,
  display_name: true,
  status: true,
  role: true,
  subscription_tier: true,
  is_verified: true,
  is_snoozed: true,
  last_active_at: true,
  onboarded_at: true,
  suspended_at: true,
  suspension_reason: true,
  created_at: true,
  deleted_at: true,
  auth_identities: {
    where: { provider: 'email' },
    select: { identifier: true },
    take: 1,
  },
  user_modes: {
    where: { is_enabled: true },
    select: { mode: true, is_primary: true },
    orderBy: { is_primary: 'desc' as const },
  },
} satisfies Prisma.UserSelect;

type UserRecord = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/** Title case for the panel, which renders mode names as labels. */
function modeLabel(mode: Mode): string {
  return mode
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function planLabel(tier: SubscriptionTier): string {
  if (tier === SubscriptionTier.advanced) {
    return 'Premium';
  }

  return tier === SubscriptionTier.basic ? 'Basic' : 'Free';
}

/**
 * The panel's single status, in priority order.
 *
 * Flagged first, then unusable, then paying. The order is the point: an
 * operator scanning a list needs the thing that requires action, and "Premium"
 * on a suspended account would bury the suspension. The honest fields are
 * returned alongside precisely because this collapse loses information.
 */
function displayStatus(user: UserRecord, tier: SubscriptionTier, isFlagged: boolean): DisplayStatus {
  if (isFlagged) {
    return 'Flagged';
  }

  if (
    user.status !== UserStatus.active ||
    user.deleted_at !== null ||
    user.is_snoozed ||
    user.onboarded_at === null
  ) {
    return 'Inactive';
  }

  const staleAfter = Date.now() - INACTIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  if (user.last_active_at.getTime() < staleAfter) {
    return 'Inactive';
  }

  return tier === SubscriptionTier.free ? 'Active' : 'Premium';
}

function toRow(
  user: UserRecord,
  tier: SubscriptionTier,
  score: number,
  photoUrl: string | null,
): AdminUserRow {
  const isFlagged = score >= 1;

  return {
    id: user.id,
    name: user.display_name,
    email: user.auth_identities[0]?.identifier ?? null,
    avatar: photoUrl,
    joinDate: user.created_at.toISOString(),
    lastActive: user.last_active_at.toISOString(),
    status: displayStatus(user, tier, isFlagged),
    plan: planLabel(tier),
    mode: user.user_modes[0] ? modeLabel(user.user_modes[0].mode) : '—',
    risk: riskLevel(score),

    account_status: user.status,
    tier,
    is_flagged: isFlagged,
    is_verified: user.is_verified,
    staff_role: user.role,
    risk_score: score,
    suspended_at: user.suspended_at?.toISOString() ?? null,
    suspension_reason: user.suspension_reason,
  };
}

/**
 * Resolves the entitling tier for a page of users.
 *
 * `resolveTier` is the authority (spec §5.10) and reads subscription rows, so
 * the denormalised `subscription_tier` column is NOT trusted here — the admin
 * list is exactly where a stale column would be believed and acted on.
 */
async function tiersFor(userIds: string[]): Promise<Map<string, SubscriptionTier>> {
  const tiers = await Promise.all(
    userIds.map(async (id) => [id, await resolveTier(id)] as const),
  );

  return new Map(tiers);
}

export interface ListUsersOptions {
  limit: number;
  cursor?: string;
  search?: string;
  status?: UserStatus;
  tier?: SubscriptionTier;
  mode?: Mode;
  flagged?: boolean;
  staff?: boolean;
}

export async function listUsers(options: ListUsersOptions): Promise<{
  users: AdminUserRow[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.user.findMany({
    where: {
      // Deleted accounts are excluded by default rather than by filter. An
      // erased account (spec §5.9) has had its identity destroyed, so listing
      // it would show a row of tombstones with nothing an operator can act on.
      deleted_at: null,
      ...(options.status ? { status: options.status } : {}),
      ...(options.staff ? { role: { not: UserRole.user } } : {}),
      ...(options.mode
        ? { user_modes: { some: { mode: options.mode, is_enabled: true } } }
        : {}),
      ...(options.search
        ? {
            OR: [
              { display_name: { contains: options.search, mode: 'insensitive' } },
              {
                auth_identities: {
                  some: { identifier: { contains: options.search, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    select: USER_SELECT,
    orderBy: { created_at: 'desc' },
    // Over-fetched when a derived filter is on, because tier and risk are
    // computed after the query and cannot be expressed in the where clause.
    take: options.tier || options.flagged ? (options.limit + 1) * 4 : options.limit + 1,
  });

  const ids = rows.map((row) => row.id);
  const [tiers, signals, photoUrls] = await Promise.all([
    tiersFor(ids),
    riskSignalsFor(ids),
    getPrimaryPhotoUrlsFor(ids),
  ]);

  let built = rows.map((row) => {
    const tier = tiers.get(row.id) ?? SubscriptionTier.free;
    const score = scoreRisk(signals.get(row.id) ?? NO_RISK_SIGNALS);

    return { row, built: toRow(row, tier, score, photoUrls.get(row.id) ?? null) };
  });

  if (options.tier) {
    built = built.filter((entry) => entry.built.tier === options.tier);
  }

  if (options.flagged !== undefined) {
    built = built.filter((entry) => entry.built.is_flagged === options.flagged);
  }

  const page = paginate(built, options.limit, (entry) => ({
    k: entry.row.created_at.toISOString(),
    id: entry.row.id,
  }));

  return {
    users: page.items.map((entry) => entry.built),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export interface AdminUserDetail extends AdminUserRow {
  date_of_birth: string | null;
  onboarded_at: string | null;
  is_snoozed: boolean;
  modes: { mode: Mode; label: string; is_primary: boolean }[];
  verification: { status: string; reviewed_at: string | null } | null;
  counts: {
    matches: number;
    reports_received: number;
    reports_filed: number;
    blocks_received: number;
    open_flags: number;
  };
  risk_signals: {
    open_reports: number;
    high_flags: number;
    medium_flags: number;
    low_flags: number;
    blocks_received: number;
  };
}

/**
 * One account, in full.
 *
 * Deliberately returns COUNTS rather than content. An operator needs to know
 * that three reports exist; reading the reported messages is a different
 * decision with a different justification, and it lives behind the moderation
 * queue where a report gives it a reason. An admin endpoint that hands over
 * anybody's conversation on request is the largest privacy surface in the
 * product, and the cheapest time to not build it is now.
 */
export async function getUser(userId: string): Promise<AdminUserDetail> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deleted_at: null },
    select: {
      ...USER_SELECT,
      date_of_birth: true,
      user_modes: {
        where: { is_enabled: true },
        select: { mode: true, is_primary: true },
        orderBy: { is_primary: 'desc' as const },
      },
      verifications: {
        select: { status: true, reviewed_at: true },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });

  if (!user) {
    throw ApiError.notFound('That account does not exist.');
  }

  const [tier, signals, photoUrls, matches, reportsFiled] = await Promise.all([
    resolveTier(user.id),
    riskSignalsFor([user.id]),
    getPrimaryPhotoUrlsFor([user.id]),
    prisma.match.count({ where: { OR: [{ user_a_id: user.id }, { user_b_id: user.id }] } }),
    prisma.report.count({ where: { reporter_id: user.id, deleted_at: null } }),
  ]);

  const signal = signals.get(user.id)!;
  const score = scoreRisk(signal);
  const row = toRow(user, tier, score, photoUrls.get(user.id) ?? null);

  return {
    ...row,
    date_of_birth: user.date_of_birth?.toISOString().slice(0, 10) ?? null,
    onboarded_at: user.onboarded_at?.toISOString() ?? null,
    is_snoozed: user.is_snoozed,
    modes: user.user_modes.map((entry) => ({
      mode: entry.mode,
      label: modeLabel(entry.mode),
      is_primary: entry.is_primary,
    })),
    verification: user.verifications[0]
      ? {
          status: user.verifications[0].status,
          reviewed_at: user.verifications[0].reviewed_at?.toISOString() ?? null,
        }
      : null,
    counts: {
      matches,
      reports_received: signal.openReports,
      reports_filed: reportsFiled,
      blocks_received: signal.blocksReceived,
      open_flags: signal.highFlags + signal.mediumFlags + signal.lowFlags,
    },
    risk_signals: {
      open_reports: signal.openReports,
      high_flags: signal.highFlags,
      medium_flags: signal.mediumFlags,
      low_flags: signal.lowFlags,
      blocks_received: signal.blocksReceived,
    },
  };
}

export interface MembershipRow {
  id: string;
  userId: string;
  startDate: string;
  subscriptionPlan: string;
  renewalDate: string;
  /**
   * The real payment source, not the panel's current union.
   *
   * The panel types this as 'Stripe' | 'Card' | 'Apple Pay'. Stripe was removed
   * from this codebase entirely on the product owner's instruction, and there is
   * no card processing here at all — so returning 'Stripe' would be inventing a
   * fact. The honest values are the `PaymentSource` enum: `apple` or `google`.
   * The panel's union needs widening; the API is not going to lie to match it.
   */
  paymentMethod: string;
  paymentStatus: 'Paid' | 'Pending' | 'Failed';
  status: SubscriptionStatus;
  is_active: boolean;
}

/**
 * Payment health, from subscription state.
 *
 * There is no payment ledger in this codebase — purchasing happens outside it —
 * so this is derived from what the subscription says. `on_billing_retry` and
 * `in_grace_period` are the two states that mean money was expected and has
 * not arrived; both still ENTITLE (spec §5.10), which is why they read as
 * Pending rather than Failed.
 */
function paymentStatusFor(subscription: {
  status: SubscriptionStatus;
  refunded_at: Date | null;
  revoked_at: Date | null;
}): 'Paid' | 'Pending' | 'Failed' {
  if (subscription.refunded_at !== null || subscription.revoked_at !== null) {
    return 'Failed';
  }

  if (
    subscription.status === SubscriptionStatus.on_billing_retry ||
    subscription.status === SubscriptionStatus.in_grace_period
  ) {
    return 'Pending';
  }

  return subscription.status === SubscriptionStatus.expired ? 'Failed' : 'Paid';
}

export async function listMemberships(userId: string): Promise<MembershipRow[]> {
  const subscriptions = await prisma.subscription.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    include: { product: { select: { name: true, billing_cycle: true } } },
  });

  const now = new Date();

  return subscriptions.map((subscription) => ({
    id: subscription.id,
    userId: subscription.user_id,
    startDate: subscription.current_period_start.toISOString(),
    subscriptionPlan: subscription.product.name,
    renewalDate: subscription.current_period_end.toISOString(),
    paymentMethod: subscription.source,
    paymentStatus: paymentStatusFor(subscription),
    status: subscription.status,
    is_active:
      subscription.current_period_end > now &&
      subscription.refunded_at === null &&
      subscription.revoked_at === null,
  }));
}

export interface ActivityRow {
  id: string;
  userId: string;
  date: string;
  recentAction: string;
  trustEvent: string;
  planEvent: string;
  lastActive: string;
  state: ActivityState;
}

/**
 * Activity history, assembled from records that already exist.
 *
 * There is no per-user event log in this codebase, and inventing one for a
 * panel screen would mean writing to a new table on every action in the
 * product — a real cost on the hot path for a screen almost nobody opens.
 *
 * So this reads what is already recorded: admin actions taken against the
 * account, its verification decisions, and its subscription changes. That is
 * less than an event stream and it is true, which is the better trade for an
 * operator deciding whether to suspend somebody.
 */
export async function listActivity(
  userId: string,
  limit: number,
): Promise<ActivityRow[]> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deleted_at: null },
    select: { id: true, last_active_at: true },
  });

  if (!user) {
    throw ApiError.notFound('That account does not exist.');
  }

  const [adminActions, verifications, subscriptions, signals] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where: { target_type: 'user', target_id: userId },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: { id: true, action: true, created_at: true },
    }),
    prisma.verification.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: { id: true, status: true, created_at: true, reviewed_at: true },
    }),
    prisma.subscription.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        created_at: true,
        product: { select: { name: true } },
      },
    }),
    riskSignalsFor([userId]),
  ]);

  const state = activityState(scoreRisk(signals.get(userId)!));
  const lastActive = user.last_active_at.toISOString();

  const entries: ActivityRow[] = [
    ...adminActions.map((row) => ({
      id: row.id,
      userId,
      date: row.created_at.toISOString(),
      recentAction: row.action,
      trustEvent: row.action.startsWith('verification') ? row.action : '—',
      planEvent: '—',
      lastActive,
      state,
    })),
    ...verifications.map((row) => ({
      id: row.id,
      userId,
      date: (row.reviewed_at ?? row.created_at).toISOString(),
      recentAction: `verification.${row.status}`,
      trustEvent: `Verification ${row.status}`,
      planEvent: '—',
      lastActive,
      state,
    })),
    ...subscriptions.map((row) => ({
      id: row.id,
      userId,
      date: row.created_at.toISOString(),
      recentAction: `subscription.${row.status}`,
      trustEvent: '—',
      planEvent: `${row.product.name} — ${row.status}`,
      lastActive,
      state,
    })),
  ];

  return entries.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

/**
 * Suspends an account.
 *
 * Writes the SAME columns `authenticate` already reads, so the account stops
 * working on its very next request rather than whenever a token happens to
 * expire. No new mechanism, and nothing for the app to learn — which is what
 * keeps this additive.
 *
 * Refuses to suspend staff. An operator suspending the account they are signed
 * in with, or a colleague mid-incident, is a foot-gun with no upside: staff
 * access is removed by changing the role, which is a separate and audited act.
 */
export async function suspendUser(input: {
  userId: string;
  reason: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminUserRow> {
  const user = await prisma.user.findFirst({
    where: { id: input.userId, deleted_at: null },
    select: { id: true, status: true, role: true },
  });

  if (!user) {
    throw ApiError.notFound('That account does not exist.');
  }

  if (user.role !== UserRole.user) {
    throw new ApiError(
      ERROR_CODES.CONFLICT,
      'Remove staff access before suspending this account.',
    );
  }

  if (user.status === UserStatus.suspended) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That account is already suspended.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      status: UserStatus.suspended,
      suspended_at: new Date(),
      suspension_reason: input.reason,
    },
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'user.suspend',
    targetType: 'user',
    targetId: user.id,
    metadata: { reason: input.reason },
    ipAddress: input.ipAddress,
  });

  logger.warn({ user_id: user.id, admin_id: input.adminId }, 'account suspended');

  return getUser(user.id);
}

export async function reinstateUser(input: {
  userId: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminUserRow> {
  const user = await prisma.user.findFirst({
    where: { id: input.userId, deleted_at: null },
    select: { id: true, status: true, onboarded_at: true, suspension_reason: true },
  });

  if (!user) {
    throw ApiError.notFound('That account does not exist.');
  }

  if (user.status !== UserStatus.suspended) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That account is not suspended.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      // Back to `pending` when onboarding was never finished, not blindly to
      // `active`. Reinstating must not skip the under-18 check that
      // `requireOnboarded` exists to enforce.
      status: user.onboarded_at === null ? UserStatus.pending : UserStatus.active,
      suspended_at: null,
      suspension_reason: null,
    },
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'user.reinstate',
    targetType: 'user',
    targetId: user.id,
    metadata: { previous_reason: user.suspension_reason },
    ipAddress: input.ipAddress,
  });

  return getUser(user.id);
}

/**
 * Changes a staff role.
 *
 * The most dangerous endpoint in the admin surface: it is how somebody grants
 * themselves more. Three guards, each for a specific way this goes wrong.
 */
export async function setStaffRole(input: {
  userId: string;
  role: UserRole;
  actingAdminId: string;
  ipAddress?: string | null;
}): Promise<AdminUserRow> {
  if (input.userId === input.actingAdminId) {
    // Nobody changes their own role. Self-demotion locks the last admin out,
    // and self-promotion is the escalation this endpoint exists to prevent.
    throw new ApiError(ERROR_CODES.CONFLICT, 'You cannot change your own role.');
  }

  const user = await prisma.user.findFirst({
    where: { id: input.userId, deleted_at: null },
    select: { id: true, role: true, status: true },
  });

  if (!user) {
    throw ApiError.notFound('That account does not exist.');
  }

  if (user.role === input.role) {
    return getUser(user.id);
  }

  if (user.role === UserRole.admin && input.role !== UserRole.admin) {
    const remaining = await prisma.user.count({
      where: { role: UserRole.admin, deleted_at: null, id: { not: user.id } },
    });

    if (remaining === 0) {
      // Removing the last administrator leaves nobody able to grant the role
      // back, and the only way out is a database edit.
      throw new ApiError(ERROR_CODES.CONFLICT, 'This is the last administrator.');
    }
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: input.role } });

  if (input.role === UserRole.user) {
    // Granular roles only make sense for staff, so they go with the status.
    // Leaving them would mean re-promoting somebody silently restores
    // permissions nobody re-granted.
    await prisma.adminRoleMember.deleteMany({ where: { user_id: user.id } });
  }

  await writeAudit({
    adminId: input.actingAdminId,
    action: 'user.role.set',
    targetType: 'user',
    targetId: user.id,
    metadata: { from: user.role, to: input.role },
    ipAddress: input.ipAddress,
  });

  logger.warn(
    { user_id: user.id, from: user.role, to: input.role, admin_id: input.actingAdminId },
    'staff role changed',
  );

  return getUser(user.id);
}
