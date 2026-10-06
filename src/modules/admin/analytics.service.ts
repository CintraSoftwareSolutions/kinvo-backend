import {
  type BillingCycle,
  Mode,
  ReportStatus,
  SubscriptionStatus,
  UserRole,
  UserStatus,
  prisma,
} from '@/db/prisma';
import { ENTITLING_STATUSES } from '@modules/subscriptions/subscriptions.service';

/**
 * The analytics dashboard (Batch 15 — admin panel).
 *
 * THE RULE THIS FILE IS WRITTEN UNDER: every number is derived from a row that
 * exists. Nothing is invented, estimated from an assumption, or carried over
 * from the panel's mock data.
 *
 * That constraint deletes one of the four tabs the mock had. There is no
 * attribution data anywhere in this schema — no referral source, no campaign
 * tag, no install attribution — so "34% referrals, 28% social ads" cannot be
 * computed from anything, and a plausible-looking number on a dashboard is
 * worse than a blank one, because somebody will spend money against it.
 * `acquisitionChannels` therefore answers a DIFFERENT question that the data
 * does support — which sign-in method people actually use — and says so in its
 * `basis`. If real attribution is wanted it has to be captured at sign-up
 * first; it is not something this endpoint can recover.
 *
 * Several series are approximate for structural reasons, and each one carries a
 * `basis` string saying exactly what it counts. An operator reading a chart is
 * about to make a decision with it and is entitled to know whether the number
 * means what its axis label suggests.
 *
 * COST. This is a dozen aggregates over whole tables, with no caching. Correct
 * for a screen a handful of operators open and completely wrong for anything on
 * the app's hot path, which is why it lives only here. If it gets slow the
 * answer is a nightly rollup table, not a cache that serves stale figures
 * without saying so.
 */

const MONTHS = 7;
const WEEKS = 4;

/** A real account: not staff, not erased. Matches snapshot.service.ts. */
const REAL_USER = { deleted_at: null, role: UserRole.user } as const;

/**
 * Share of a mode's users who must be verified before it reads as High trust.
 *
 * A threshold, not a measurement — it is an editorial line this file draws so
 * the panel's two-value badge has a definition. Moving it is a one-line change
 * here and nowhere else.
 */
const HIGH_TRUST_AT = 0.5;

function modeLabel(mode: string): string {
  return mode
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

/** Start of the UTC month `offset` months before `from`. */
function monthStart(from: Date, offset: number): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - offset, 1));
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function monthLabel(date: Date): string {
  return MONTH_NAMES[date.getUTCMonth()]!;
}

function monthlyEquivalent(amountMinor: number, cycle: BillingCycle): number {
  return cycle === 'yearly' ? Math.round(amountMinor / 12) : amountMinor;
}

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

export interface Series<TPoint> {
  /** What the numbers actually count. Rendered as the chart's footnote. */
  basis: string;
  points: TPoint[];
}

export interface EngagementPoint {
  month: string;
  activeUsers: number;
  verifiedUsers: number;
}

/**
 * Monthly engagement.
 *
 * COUNTS THE ACCOUNT BASE AT EACH MONTH END, not monthly active users.
 *
 * True MAU is not recoverable: `last_active_at` is a single column that is
 * overwritten on every visit, so there is no history to bucket. Bucketing it
 * anyway would draw a chart where every month before this one looks nearly
 * empty — not an approximation, just wrong. An events table would fix it and is
 * a product decision, not something to fake here.
 *
 * What is returned is true and monotonic: how many usable accounts existed at
 * the end of each month, and how many of those were verified.
 */
async function engagement(now: Date): Promise<Series<EngagementPoint>> {
  const points: EngagementPoint[] = [];

  for (let index = MONTHS - 1; index >= 0; index -= 1) {
    const start = monthStart(now, index);
    // The end of this bucket is the start of the next, or now for the
    // current month — so the last point matches today's totals exactly.
    const end = index === 0 ? now : monthStart(now, index - 1);

    const [total, verified] = await Promise.all([
      prisma.user.count({
        where: { ...REAL_USER, created_at: { lt: end }, onboarded_at: { not: null } },
      }),
      prisma.user.count({
        where: {
          ...REAL_USER,
          created_at: { lt: end },
          onboarded_at: { not: null },
          is_verified: true,
        },
      }),
    ]);

    points.push({ month: monthLabel(start), activeUsers: total, verifiedUsers: verified });
  }

  return {
    basis:
      'Onboarded accounts existing at each month end, and the verified share of them. Not monthly active users — last_active_at keeps no history.',
    points,
  };
}

export interface WeeklyResolutionPoint {
  week: string;
  reported: number;
  resolved: number;
}

/**
 * Four weeks of moderation load. Fully real.
 *
 * `resolved` counts reports that reached a DECISION in that week, not reports
 * raised that week which are now resolved. The second is a different question
 * and mixing them would make the two lines incomparable — a week can and
 * should resolve more than it received.
 */
async function weeklyResolution(now: Date): Promise<Series<WeeklyResolutionPoint>> {
  const week = 7 * 24 * 60 * 60 * 1000;
  const points: WeeklyResolutionPoint[] = [];

  for (let index = WEEKS - 1; index >= 0; index -= 1) {
    const start = new Date(now.getTime() - (index + 1) * week);
    const end = new Date(now.getTime() - index * week);

    const [reported, resolved] = await Promise.all([
      prisma.report.count({
        where: { created_at: { gte: start, lt: end }, deleted_at: null },
      }),
      prisma.report.count({
        where: {
          reviewed_at: { gte: start, lt: end },
          status: { in: [ReportStatus.actioned, ReportStatus.dismissed] },
          deleted_at: null,
        },
      }),
    ]);

    points.push({ week: `Week ${WEEKS - index}`, reported, resolved });
  }

  return {
    basis: 'Reports raised per week against decisions reached per week.',
    points,
  };
}

// ---------------------------------------------------------------------------
// Monetization
// ---------------------------------------------------------------------------

export interface SubscriptionMixRow {
  plan: string;
  active: number;
  /** Subscriptions that have been through at least one renewal. */
  renewed: number;
  churn_percent: number;
  mrr_minor: number;
  currency: string | null;
}

export interface RevenueMetric {
  label: string;
  /** Display string, for a panel that renders text. Authoritative value below. */
  value: string;
  /**
   * spec §4.6: money is integer minor units plus a currency, never a formatted
   * string. `value` exists because the panel's cards render text; this is the
   * figure anything programmatic must read.
   */
  amount_minor: number | null;
  currency: string | null;
  percent: number | null;
}

/**
 * Per-plan mix, plus the revenue cards.
 *
 * "Renewed" is real and worth explaining: a subscription whose
 * `current_period_start` is later than its `created_at` has had its period
 * moved forward at least once, which only happens on a renewal. There is no
 * renewal ledger in this codebase, and this is the one honest proxy the schema
 * supports.
 *
 * Churn is cancelled-or-expired over everything ever sold on that plan. It is a
 * lifetime rate, not a monthly one — a monthly rate needs cohorts, and cohorts
 * need the ledger that does not exist.
 */
async function monetization(now: Date): Promise<{
  subscriptionMix: Series<SubscriptionMixRow>;
  revenuePulse: Series<RevenueMetric>;
}> {
  const entitling = [...ENTITLING_STATUSES] as SubscriptionStatus[];

  const [products, subscriptions, onboardedCount] = await Promise.all([
    prisma.subscriptionProduct.findMany({
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      select: {
        id: true,
        name: true,
        billing_cycle: true,
        price_versions: {
          where: { effective_to: null },
          orderBy: { effective_from: 'desc' },
          take: 1,
          select: { amount_minor: true, currency: true },
        },
      },
    }),
    prisma.subscription.findMany({
      select: {
        product_id: true,
        status: true,
        created_at: true,
        current_period_start: true,
        current_period_end: true,
        refunded_at: true,
        revoked_at: true,
        user_id: true,
      },
    }),
    prisma.user.count({ where: { ...REAL_USER, onboarded_at: { not: null } } }),
  ]);

  const rows: SubscriptionMixRow[] = [];

  let totalMrr = 0;
  let totalActive = 0;
  let totalRenewed = 0;
  let totalRenewable = 0;
  let totalTroubled = 0;
  const entitledUsers = new Set<string>();
  let currency: string | null = null;

  for (const product of products) {
    const mine = subscriptions.filter((row) => row.product_id === product.id);
    const price = product.price_versions[0] ?? null;

    if (price && currency === null) {
      currency = price.currency;
    }

    const active = mine.filter(
      (row) =>
        entitling.includes(row.status) &&
        row.refunded_at === null &&
        row.revoked_at === null &&
        row.current_period_end > now,
    );

    for (const row of active) {
      entitledUsers.add(row.user_id);
    }

    const renewed = mine.filter(
      (row) => row.current_period_start.getTime() > row.created_at.getTime(),
    ).length;

    const lost = mine.filter(
      (row) =>
        row.status === SubscriptionStatus.expired ||
        row.status === SubscriptionStatus.cancelled ||
        row.refunded_at !== null ||
        row.revoked_at !== null,
    ).length;

    const mrr = price ? monthlyEquivalent(price.amount_minor, product.billing_cycle) * active.length : 0;

    totalMrr += mrr;
    totalActive += active.length;
    totalRenewed += renewed;
    totalRenewable += mine.length;
    totalTroubled += mine.filter(
      (row) =>
        row.status === SubscriptionStatus.on_billing_retry ||
        row.status === SubscriptionStatus.expired,
    ).length;

    rows.push({
      plan: product.name,
      active: active.length,
      renewed,
      churn_percent: pct(lost, mine.length),
      mrr_minor: mrr,
      currency: price?.currency ?? null,
    });
  }

  const revenuePulse: RevenueMetric[] = [
    {
      label: 'MRR',
      value: currency
        ? `${currency} ${(totalMrr / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : '—',
      amount_minor: totalMrr,
      currency,
      percent: null,
    },
    {
      label: 'Renewal rate',
      value: `${pct(totalRenewed, totalRenewable)}%`,
      amount_minor: null,
      currency: null,
      percent: pct(totalRenewed, totalRenewable),
    },
    {
      label: 'Failed charges',
      value: `${pct(totalTroubled, totalRenewable)}%`,
      amount_minor: null,
      currency: null,
      percent: pct(totalTroubled, totalRenewable),
    },
    {
      // Replaces the mock's "Upsell conversion", which needs a tier-change
      // history this schema does not keep. Paid conversion is the same
      // business question answered from rows that exist.
      label: 'Paid conversion',
      value: `${pct(entitledUsers.size, onboardedCount)}%`,
      amount_minor: null,
      currency: null,
      percent: pct(entitledUsers.size, onboardedCount),
    },
  ];

  return {
    subscriptionMix: {
      basis:
        'Active = currently entitling and inside its paid period. Renewed = period start later than creation, the only renewal evidence in the schema. Churn is lifetime, not monthly.',
      points: rows,
    },
    revenuePulse: {
      basis: `MRR normalises yearly plans to a month; it is not what was billed this month. Based on ${totalActive} entitling subscriptions.`,
      points: revenuePulse,
    },
  };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface ChurnPoint {
  month: string;
  /** Monthly-cycle cancellations. */
  primary: number;
  /** Yearly-cycle cancellations. */
  secondary: number;
}

/**
 * Cancellations per month, split by billing cycle.
 *
 * Real: `cancelled_at` is a recorded instant. Note that cancelling is not the
 * same as losing access — a cancelled subscription keeps its entitlement until
 * `current_period_end` (spec §5.10) — so this chart leads the revenue impact
 * rather than showing it.
 */
async function churnByBilling(now: Date): Promise<Series<ChurnPoint>> {
  const windowStart = monthStart(now, MONTHS - 1);

  const cancelled = await prisma.subscription.findMany({
    where: { cancelled_at: { gte: windowStart } },
    select: { cancelled_at: true, product: { select: { billing_cycle: true } } },
  });

  const buckets = new Map<string, ChurnPoint>();

  for (let index = MONTHS - 1; index >= 0; index -= 1) {
    const start = monthStart(now, index);
    buckets.set(start.toISOString(), {
      month: monthLabel(start),
      primary: 0,
      secondary: 0,
    });
  }

  for (const row of cancelled) {
    if (!row.cancelled_at) {
      continue;
    }

    const key = new Date(
      Date.UTC(row.cancelled_at.getUTCFullYear(), row.cancelled_at.getUTCMonth(), 1),
    ).toISOString();

    const bucket = buckets.get(key);

    if (bucket) {
      if (row.product.billing_cycle === 'yearly') {
        bucket.secondary += 1;
      } else {
        bucket.primary += 1;
      }
    }
  }

  return {
    basis:
      'Cancellations by the month they were requested, monthly plans against yearly. Access continues to period end, so this leads the revenue effect.',
    points: [...buckets.values()],
  };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface ModePerformanceRow {
  mode: string;
  activeUsers: number;
  completion_percent: number;
  trustScore: 'High' | 'Medium';
}

/**
 * Per-mode health. All eight modes, always — a mode nobody enabled is a real
 * and useful zero, and dropping it would hide exactly the thing worth seeing.
 */
async function modePerformance(): Promise<Series<ModePerformanceRow>> {
  const modes = Object.values(Mode);

  const rows = await Promise.all(
    modes.map(async (mode) => {
      const [enabled, onboarded, verified] = await Promise.all([
        prisma.userMode.count({ where: { mode, is_enabled: true, user: REAL_USER } }),
        prisma.userMode.count({
          where: {
            mode,
            is_enabled: true,
            user: { ...REAL_USER, onboarded_at: { not: null }, status: UserStatus.active },
          },
        }),
        prisma.userMode.count({
          where: { mode, is_enabled: true, user: { ...REAL_USER, is_verified: true } },
        }),
      ]);

      return {
        mode: modeLabel(mode),
        activeUsers: enabled,
        completion_percent: pct(onboarded, enabled),
        trustScore: (enabled > 0 && verified / enabled >= HIGH_TRUST_AT
          ? 'High'
          : 'Medium') as 'High' | 'Medium',
      };
    }),
  );

  return {
    basis: `Users with the mode enabled; completion is the onboarded and active share; trust is High at ${Math.round(
      HIGH_TRUST_AT * 100,
    )}% verified or more.`,
    points: rows.sort((a, b) => b.activeUsers - a.activeUsers),
  };
}

export interface AcquisitionMetric {
  label: string;
  value: string;
  percent: number;
  users: number;
}

/**
 * NOT acquisition channels. Sign-in methods.
 *
 * Read the file header before changing this. Nothing in this schema records
 * where a user came from, so referral/campaign/organic shares cannot be
 * computed — and a made-up number here would be acted on. What IS recorded is
 * which provider each account authenticates with, which answers a real and
 * adjacent question: where sign-up friction actually is.
 *
 * Counted per USER, not per identity: one person with Google and email linked
 * is one account, and counting identities would make the shares sum past 100%.
 * The primary identity is the earliest one, which is the method they signed up
 * with rather than one they added later.
 */
async function acquisitionChannels(): Promise<Series<AcquisitionMetric>> {
  const identities = await prisma.authIdentity.findMany({
    where: { user: REAL_USER },
    orderBy: { created_at: 'asc' },
    select: { user_id: true, provider: true },
  });

  const firstByUser = new Map<string, string>();

  for (const identity of identities) {
    if (!firstByUser.has(identity.user_id)) {
      firstByUser.set(identity.user_id, identity.provider);
    }
  }

  const counts = new Map<string, number>();

  for (const provider of firstByUser.values()) {
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  const total = firstByUser.size;

  const labels: Record<string, string> = {
    email: 'Email',
    phone: 'Phone',
    google: 'Google',
    apple: 'Apple',
  };

  return {
    basis:
      'Sign-in method of each account’s first identity. This is NOT marketing attribution — no referral or campaign source is recorded anywhere in this system.',
    points: [...counts.entries()]
      .map(([provider, users]) => ({
        label: labels[provider] ?? provider,
        value: `${pct(users, total)}%`,
        percent: pct(users, total),
        users,
      }))
      .sort((a, b) => b.users - a.users),
  };
}

// ---------------------------------------------------------------------------

export interface AnalyticsDashboard {
  generated_at: string;
  engagement: Series<EngagementPoint>;
  weeklyResolution: Series<WeeklyResolutionPoint>;
  subscriptionMix: Series<SubscriptionMixRow>;
  revenuePulse: Series<RevenueMetric>;
  churnByBilling: Series<ChurnPoint>;
  modePerformance: Series<ModePerformanceRow>;
  acquisitionChannels: Series<AcquisitionMetric>;
}

/**
 * One call for the whole dashboard.
 *
 * Four tabs behind one request rather than four, because the panel renders them
 * as tabs over one dataset and four endpoints would mean four round trips to
 * show one screen. `generated_at` is returned so the panel can show when the
 * figures were counted — nothing here is cached, so it is always now.
 */
export async function analyticsDashboard(now = new Date()): Promise<AnalyticsDashboard> {
  const [
    engagementSeries,
    resolution,
    money,
    churn,
    modes,
    channels,
  ] = await Promise.all([
    engagement(now),
    weeklyResolution(now),
    monetization(now),
    churnByBilling(now),
    modePerformance(),
    acquisitionChannels(),
  ]);

  return {
    generated_at: now.toISOString(),
    engagement: engagementSeries,
    weeklyResolution: resolution,
    subscriptionMix: money.subscriptionMix,
    revenuePulse: money.revenuePulse,
    churnByBilling: churn,
    modePerformance: modes,
    acquisitionChannels: channels,
  };
}
