import { type Prisma, SubscriptionStatus, UserRole, UserStatus, prisma } from '@/db/prisma';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { HIGH_AT, MEDIUM_AT, riskSignalsFor, scoreRisk } from './risk';

/**
 * The user-management snapshot (Batch 15 — admin panel).
 *
 * Every figure here is COUNTED, never stored. A dashboard backed by a
 * maintained counter is a dashboard that is quietly wrong: the counter drifts
 * the first time a row changes by a path nobody remembered to update, and it
 * keeps rendering a confident number.
 *
 * The cost is a dozen aggregate queries per load. That is the right trade for
 * a screen a handful of operators open, and the wrong one for anything on the
 * app's hot path — which is why nothing like this exists outside the admin
 * module.
 *
 * WHERE A FIGURE IS APPROXIMATE, the comment says so. An operator acting on a
 * number deserves to know which ones are exact.
 */

/** Matches `users.service.ts`. Same rule, same threshold. */
const INACTIVE_AFTER_DAYS = 30;

export interface SnapshotMetric {
  label: string;
  value: number;
  tone: 'purple' | 'emerald' | 'rose' | 'blue';
}

export interface NamedValue {
  name: string;
  detail: string;
  value?: number;
  avatar?: string | null;
}

export interface SnapshotData {
  metrics: SnapshotMetric[];
  statusCounts: { label: string; value: number }[];
  topModes: { label: string; value: string }[];
  paymentHealth: { label: 'Paid' | 'Pending' | 'Failed'; value: number }[];
  highValueMembers: NamedValue[];
  attentionQueue: { name: string; detail: string; risk: 'Medium' | 'High' }[];
  recentAccountEvents: { name: string; event: string }[];
}

function modeLabel(mode: string): string {
  return mode
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** A real account: not staff, not erased. */
const REAL_USER = { deleted_at: null, role: UserRole.user } as const;

/**
 * Accounts moderation is currently looking at.
 *
 * The same definition `risk.ts` uses for a non-zero score: an open report or an
 * unresolved flag. Expressed here as one query over user ids rather than by
 * scoring every account, because scoring the whole table to count a badge would
 * be thousands of queries.
 */
async function flaggedUserIds(): Promise<Set<string>> {
  const [reported, flagged] = await Promise.all([
    prisma.report.findMany({
      where: { status: { in: ['open', 'under_review'] }, deleted_at: null },
      select: { reported_id: true },
      distinct: ['reported_id'],
    }),
    prisma.moderationFlag.findMany({
      where: { subject_type: 'user', resolved_at: null },
      select: { subject_id: true },
      distinct: ['subject_id'],
    }),
  ]);

  return new Set([
    ...reported.map((row) => row.reported_id),
    ...flagged.map((row) => row.subject_id),
  ]);
}

/**
 * Subscriptions that currently entitle. Mirrors `resolveTier`'s conditions.
 *
 * A function rather than a constant, because `as const` would freeze the
 * `in` array and Prisma's filter type wants a mutable one.
 */
function entitling(): Prisma.SubscriptionWhereInput {
  return {
    status: {
      in: [
        SubscriptionStatus.active,
        SubscriptionStatus.in_grace_period,
        SubscriptionStatus.on_billing_retry,
        SubscriptionStatus.cancelled,
      ],
    },
    refunded_at: null,
    revoked_at: null,
  };
}

export async function userSnapshot(): Promise<SnapshotData> {
  const staleAfter = new Date(Date.now() - INACTIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();

  const flagged = await flaggedUserIds();

  const [
    visibleUsers,
    premiumUserIds,
    totalMatches,
    inactiveCount,
    modeGroups,
    subscriptions,
    topSubscriptions,
    recentAudit,
    recentVerifications,
  ] = await Promise.all([
    prisma.user.count({
      where: {
        ...REAL_USER,
        status: UserStatus.active,
        onboarded_at: { not: null },
        is_snoozed: false,
      },
    }),
    prisma.subscription
      .findMany({
        where: { ...entitling(), current_period_end: { gt: now } },
        select: { user_id: true },
        distinct: ['user_id'],
      })
      .then((rows) => new Set(rows.map((row) => row.user_id))),
    prisma.match.count(),
    prisma.user.count({
      where: {
        ...REAL_USER,
        OR: [
          { status: { not: UserStatus.active } },
          { onboarded_at: null },
          { is_snoozed: true },
          { last_active_at: { lt: staleAfter } },
        ],
      },
    }),
    prisma.userMode.groupBy({
      by: ['mode'],
      where: { is_enabled: true, user: REAL_USER },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 4,
    }),
    prisma.subscription.findMany({
      select: { status: true, refunded_at: true, revoked_at: true },
    }),
    prisma.subscription.findMany({
      where: { ...entitling(), current_period_end: { gt: now } },
      select: {
        user: { select: { id: true, display_name: true } },
        product: {
          select: {
            name: true,
            price_versions: {
              where: { effective_to: null },
              select: { amount_minor: true, currency: true },
              take: 1,
            },
          },
        },
      },
      take: 50,
    }),
    prisma.adminAuditLog.findMany({
      where: { target_type: 'user' },
      orderBy: { created_at: 'desc' },
      take: 6,
      select: { action: true, target_id: true },
    }),
    prisma.verification.findMany({
      where: { reviewed_at: { not: null } },
      orderBy: { reviewed_at: 'desc' },
      take: 6,
      select: { status: true, user: { select: { display_name: true } } },
    }),
  ]);

  // --- metrics -------------------------------------------------------------

  const metrics: SnapshotMetric[] = [
    { label: 'Visible users', value: visibleUsers, tone: 'purple' },
    { label: 'Premium members', value: premiumUserIds.size, tone: 'emerald' },
    { label: 'Flagged accounts', value: flagged.size, tone: 'rose' },
    {
      // Matches per visible user. Doubled because a match belongs to two
      // people, so counting rows once per pair would halve everyone's figure.
      label: 'Avg matches',
      value: visibleUsers === 0 ? 0 : Math.round((totalMatches * 2) / visibleUsers),
      tone: 'blue',
    },
  ];

  // --- status counts -------------------------------------------------------
  //
  // Priority order, matching `displayStatus` in users.service.ts: flagged
  // first, then unusable, then paying. The buckets must not overlap or the
  // chart sums to more than the user count, so each subtracts what the one
  // above it already claimed.

  const totalReal = await prisma.user.count({ where: REAL_USER });
  const flaggedCount = flagged.size;
  const inactiveNotFlagged = Math.max(0, inactiveCount - flaggedCount);
  const premiumNotFlaggedOrInactive = Math.max(
    0,
    premiumUserIds.size - flaggedCount,
  );
  const activeFree = Math.max(
    0,
    totalReal - flaggedCount - inactiveNotFlagged - premiumNotFlaggedOrInactive,
  );

  const statusCounts = [
    { label: 'Active', value: activeFree },
    { label: 'Premium', value: premiumNotFlaggedOrInactive },
    { label: 'Inactive', value: inactiveNotFlagged },
    { label: 'Flagged', value: flaggedCount },
  ];

  // --- modes ---------------------------------------------------------------

  const topModes = modeGroups.map((group) => ({
    label: modeLabel(group.mode),
    value: `${group._count.id} active`,
  }));

  // --- payment health ------------------------------------------------------

  let paid = 0;
  let pending = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    if (subscription.refunded_at !== null || subscription.revoked_at !== null) {
      failed += 1;
    } else if (
      subscription.status === SubscriptionStatus.on_billing_retry ||
      subscription.status === SubscriptionStatus.in_grace_period
    ) {
      // Money was expected and has not arrived, but both states still entitle
      // (spec §5.10) — so Pending, not Failed.
      pending += 1;
    } else if (subscription.status === SubscriptionStatus.expired) {
      failed += 1;
    } else {
      paid += 1;
    }
  }

  const paymentHealth: SnapshotData['paymentHealth'] = [
    { label: 'Paid', value: paid },
    { label: 'Pending', value: pending },
    { label: 'Failed', value: failed },
  ];

  // --- high-value members --------------------------------------------------
  //
  // Ranked by what their current plan costs, in MAJOR units for display only.
  // Not lifetime revenue: there is no payment ledger in this codebase, so a
  // lifetime figure would be invented. This is "who is on the most expensive
  // plan", which is a different and true thing.

  const byValue = topSubscriptions
    .map((subscription) => ({
      id: subscription.user.id,
      name: subscription.user.display_name,
      detail: subscription.product.name,
      minor: subscription.product.price_versions[0]?.amount_minor ?? 0,
    }))
    .sort((a, b) => b.minor - a.minor)
    .slice(0, 4);

  const valuePhotos = await getPrimaryPhotoUrlsFor(byValue.map((entry) => entry.id));

  const highValueMembers: NamedValue[] = byValue.map((entry) => ({
    name: entry.name,
    detail: entry.detail,
    value: Math.round(entry.minor / 100),
    avatar: valuePhotos.get(entry.id) ?? null,
  }));

  // --- attention queue -----------------------------------------------------
  //
  // Scored properly rather than approximated, because this is the one list an
  // operator acts on directly. Only the flagged set is scored, which keeps it
  // to a bounded number of accounts however large the table grows.

  const flaggedIds = [...flagged].slice(0, 100);
  const signals = await riskSignalsFor(flaggedIds);

  const scored = flaggedIds
    .map((id) => ({ id, score: scoreRisk(signals.get(id)!) }))
    .filter((entry) => entry.score >= MEDIUM_AT)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const attentionUsers = await prisma.user.findMany({
    where: { id: { in: scored.map((entry) => entry.id) } },
    select: {
      id: true,
      display_name: true,
      status: true,
      user_modes: {
        where: { is_enabled: true, is_primary: true },
        select: { mode: true },
        take: 1,
      },
    },
  });

  const byId = new Map(attentionUsers.map((user) => [user.id, user]));

  const attentionQueue = scored.flatMap((entry) => {
    const user = byId.get(entry.id);

    if (!user) {
      return [];
    }

    return [
      {
        name: user.display_name,
        detail: `${user.user_modes[0] ? modeLabel(user.user_modes[0].mode) : 'No mode'} | ${user.status}`,
        risk: (entry.score >= HIGH_AT ? 'High' : 'Medium') as 'Medium' | 'High',
      },
    ];
  });

  // --- recent events -------------------------------------------------------
  //
  // Real recorded events only: admin actions and verification decisions. There
  // is no product event stream, and adding one for this panel would mean a
  // write on every action in the app for a screen a few people open.

  const auditTargets = await prisma.user.findMany({
    where: { id: { in: recentAudit.map((row) => row.target_id ?? '') } },
    select: { id: true, display_name: true },
  });

  const auditNames = new Map(auditTargets.map((user) => [user.id, user.display_name]));

  const recentAccountEvents = [
    ...recentAudit.map((row) => ({
      name: auditNames.get(row.target_id ?? '') ?? 'Unknown account',
      event: row.action,
    })),
    ...recentVerifications.map((row) => ({
      name: row.user.display_name,
      event: `Verification ${row.status}`,
    })),
  ].slice(0, 6);

  return {
    metrics,
    statusCounts,
    topModes,
    paymentHealth,
    highValueMembers,
    attentionQueue,
    recentAccountEvents,
  };
}
