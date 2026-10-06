import { ModerationSeverity, ReportStatus, prisma } from '@/db/prisma';

/**
 * Account risk, derived (Batch 15 — admin panel).
 *
 * The panel renders a risk level on every user row and an "attention queue"
 * ordered by it. There is no risk column in the database and there should not
 * be one: a stored score goes stale the moment anything it summarises changes,
 * and nobody notices because it still renders.
 *
 * So it is computed from signals that already exist, every time. The cost is a
 * few counts per page, which is why they are batched for the whole page rather
 * than resolved per row.
 *
 * THE WEIGHTS ARE A PRODUCT JUDGEMENT, not a fact, and they are in one table
 * here so retuning them is a single edit rather than a hunt. What follows is
 * the reasoning, so whoever changes them knows what they are trading:
 *
 *   An OPEN REPORT is the strongest signal, because a person took the trouble
 *   to file it and nobody has yet decided it was wrong. A resolved report
 *   counts for nothing — it has been judged, and continuing to hold it against
 *   an account would mean clearing somebody never actually clears them.
 *
 *   A HIGH-SEVERITY moderation flag matches one report. It is automated rather
 *   than human, so it earns less than its severity label suggests; the rules
 *   are advisory by design (spec §5.4) and false positives are expected.
 *
 *   BLOCKS RECEIVED count least and are capped. People block for reasons that
 *   are not misconduct — an ex, a colleague, a changed mind — so a popular
 *   account accumulates them harmlessly. Uncapped, this would rank the most
 *   active users as the most dangerous.
 */

export type RiskLevel = 'Low risk' | 'Medium risk' | 'High risk';

/** The panel's narrower label for the same thing, on the activity screen. */
export type ActivityState = 'Healthy' | 'Watch' | 'Escalated';

const WEIGHTS = {
  OPEN_REPORT: 3,
  /**
   * `critical` is its own weight, not folded into high.
   *
   * The enum has five levels and an earlier version of this file silently scored
   * `critical` as zero by only naming the three in the middle — the worst
   * possible failure for a risk score, because the most dangerous accounts
   * would have read as Low risk. Every level is now named explicitly.
   */
  FLAG_CRITICAL: 5,
  FLAG_HIGH: 3,
  FLAG_MEDIUM: 2,
  FLAG_LOW: 1,
  BLOCK_RECEIVED: 1,
} as const;

/**
 * Blocks stop counting past this many.
 *
 * Without it the score tracks popularity rather than conduct, and the busiest
 * accounts sit permanently at the top of the attention queue.
 */
const BLOCK_CAP = 3;

const MEDIUM_AT = 1;
const HIGH_AT = 5;

export interface RiskSignals {
  openReports: number;
  criticalFlags: number;
  highFlags: number;
  mediumFlags: number;
  lowFlags: number;
  blocksReceived: number;
}

/**
 * No signals at all.
 *
 * Exported rather than written inline by callers: an inline copy drifts the
 * moment a signal is added, and the drift is silent — the new signal simply
 * scores zero for anybody the map did not cover.
 */
export const NO_RISK_SIGNALS: RiskSignals = {
  openReports: 0,
  criticalFlags: 0,
  highFlags: 0,
  mediumFlags: 0,
  lowFlags: 0,
  blocksReceived: 0,
};

/** Pure, so the weights can be reasoned about and tested without a database. */
export function scoreRisk(signals: RiskSignals): number {
  return (
    signals.openReports * WEIGHTS.OPEN_REPORT +
    signals.criticalFlags * WEIGHTS.FLAG_CRITICAL +
    signals.highFlags * WEIGHTS.FLAG_HIGH +
    signals.mediumFlags * WEIGHTS.FLAG_MEDIUM +
    signals.lowFlags * WEIGHTS.FLAG_LOW +
    Math.min(signals.blocksReceived, BLOCK_CAP) * WEIGHTS.BLOCK_RECEIVED
  );
}

export function riskLevel(score: number): RiskLevel {
  if (score >= HIGH_AT) {
    return 'High risk';
  }

  return score >= MEDIUM_AT ? 'Medium risk' : 'Low risk';
}

export function activityState(score: number): ActivityState {
  if (score >= HIGH_AT) {
    return 'Escalated';
  }

  return score >= MEDIUM_AT ? 'Watch' : 'Healthy';
}

/**
 * Signals for a whole page of users in three queries, not three per user.
 *
 * The same reason compact objects exist (spec §4.7): a risk level resolved per
 * row turns a twenty-user page into sixty queries, and the admin list is the
 * first screen anybody opens.
 */
export async function riskSignalsFor(userIds: string[]): Promise<Map<string, RiskSignals>> {
  const empty = NO_RISK_SIGNALS;

  const signals = new Map<string, RiskSignals>(userIds.map((id) => [id, { ...empty }]));

  if (userIds.length === 0) {
    return signals;
  }

  const [reports, flags, blocks] = await Promise.all([
    prisma.report.groupBy({
      by: ['reported_id'],
      // Open and under review only. `actioned` and `dismissed` have both been
      // JUDGED, and holding a judged report against an account for ever would
      // mean clearing somebody never actually clears them.
      where: {
        reported_id: { in: userIds },
        status: { in: [ReportStatus.open, ReportStatus.under_review] },
        deleted_at: null,
      },
      _count: { id: true },
    }),
    prisma.moderationFlag.groupBy({
      by: ['subject_id', 'severity'],
      // Unresolved only, for the same reason.
      where: { subject_id: { in: userIds }, subject_type: 'user', resolved_at: null },
      _count: { id: true },
    }),
    prisma.block.groupBy({
      by: ['blocked_id'],
      where: { blocked_id: { in: userIds } },
      _count: { id: true },
    }),
  ]);

  for (const row of reports) {
    const entry = signals.get(row.reported_id);
    if (entry) {
      entry.openReports = row._count.id;
    }
  }

  for (const row of flags) {
    const entry = signals.get(row.subject_id);
    if (!entry) {
      continue;
    }

    if (row.severity === ModerationSeverity.critical) {
      entry.criticalFlags += row._count.id;
    } else if (row.severity === ModerationSeverity.high) {
      entry.highFlags += row._count.id;
    } else if (row.severity === ModerationSeverity.medium) {
      entry.mediumFlags += row._count.id;
    } else if (row.severity === ModerationSeverity.low) {
      entry.lowFlags += row._count.id;
    }
    // `none` is deliberately not counted, and this comment is here so the
    // omission does not read as the bug it looks like: severity `none` means
    // the scan found nothing, so a flag carrying it is not a risk signal. The
    // four levels above are the complete set that is.
  }

  for (const row of blocks) {
    const entry = signals.get(row.blocked_id);
    if (entry) {
      entry.blocksReceived = row._count.id;
    }
  }

  return signals;
}

export { WEIGHTS as RISK_WEIGHTS, BLOCK_CAP as RISK_BLOCK_CAP, MEDIUM_AT, HIGH_AT };
