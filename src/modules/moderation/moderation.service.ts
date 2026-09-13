import { createHash } from 'node:crypto';

import { ModerationSeverity, type Prisma, ReportStatus, prisma } from '@/db/prisma';
import {
  type ModerationFinding,
  type ModerationProvider,
  type ModerationResult,
  severityAtLeast,
} from '@/providers/moderation.provider';
import { RulesModerationProvider } from '@/providers/rules-moderation.provider';
import { ApiError } from '@utils/api-error';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';

/**
 * Moderation (spec §5.4, Batch 10).
 *
 * Two rules govern everything in this file:
 *
 *  1. **Advisory, never blocking.** The check returns findings and a
 *     recommendation. It does not refuse a send. The client shows "Edit" or
 *     "Send anyway", and an override is recorded — a user pushing past a scam
 *     warning is exactly what the moderation team needs to see later.
 *
 *  2. **Fail open.** If the provider is slow or throws, the send is allowed and
 *     the content is queued for asynchronous review. Blocking a user's message
 *     on a third party's outage is a worse failure than reviewing it late.
 */

/** A slow provider must not become a slow product. */
const PROVIDER_TIMEOUT_MS = 2000;

/** At or above this, the client shows a warning dialog before sending. */
const WARN_THRESHOLD = ModerationSeverity.low;

/** At or above this, the content is queued for a human regardless of override. */
const FLAG_THRESHOLD = ModerationSeverity.medium;

let provider: ModerationProvider = new RulesModerationProvider();

/** Swapping the provider is a one-line change — that is the point of decision #8. */
export function setModerationProvider(next: ModerationProvider): void {
  provider = next;
}

export function getModerationProvider(): ModerationProvider {
  return provider;
}

export function resetModerationProvider(): void {
  provider = new RulesModerationProvider();
}

/**
 * Content is hashed, never stored.
 *
 * The check row has to be linkable to what was checked so a moderator can tell
 * two reports about the same text apart — but keeping a copy of every private
 * message a user considered sending, including the ones they edited away, is a
 * surveillance database nobody asked for.
 */
function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 64);
}

async function withTimeout(content: string): Promise<ModerationResult> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      provider.check(content),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('moderation timeout')), PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // FAIL OPEN (spec §5.4). Never rethrow: the caller is about to let the user
    // send, and an exception here would turn a provider outage into a failed
    // message.
    logger.error({ err: error, provider: provider.name }, 'moderation check failed — failing open');

    return {
      severity: ModerationSeverity.none,
      findings: [],
      provider: provider.name,
      timed_out: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface CheckInput {
  userId: string;
  content: string;
  subjectType: string;
  subjectId?: string | null;
  /** Set when the client is recording a decision the user already made. */
  overridden?: boolean;
}

export interface CheckView {
  check_id: string;
  severity: ModerationSeverity;
  /** spec §5.4: the client renders "Edit message" / "Send anyway" from this. */
  should_warn: boolean;
  /** Always true. The check never refuses a send — it is advisory (spec §5.4). */
  can_send: boolean;
  findings: ModerationFinding[];
  /** True when the provider was unreachable and the content was let through. */
  timed_out: boolean;
  provider: string;
}

/**
 * The pre-send check (spec §5.4).
 *
 * A separate endpoint rather than part of the send, so the client can show the
 * warning dialog before committing to anything.
 */
export async function check(input: CheckInput): Promise<CheckView> {
  const result = await withTimeout(input.content);

  const record = await prisma.moderationCheck.create({
    data: {
      user_id: input.userId,
      subject_type: input.subjectType,
      subject_id: input.subjectId ?? null,
      content_hash: hash(input.content),
      provider: result.provider,
      severity: result.severity,
      categories: result.findings.map((finding) => finding.category),
      raw_response: (result.raw ?? null) as Prisma.InputJsonValue,
      was_overridden: input.overridden ?? false,
      timed_out: result.timed_out,
    },
    select: { id: true },
  });

  // Queued even when the user never sends: content bad enough to reach this
  // threshold is worth a look regardless of what they did next.
  if (severityAtLeast(result.severity, FLAG_THRESHOLD)) {
    await raiseFlag({
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? record.id,
      reason: describe(result.findings),
      severity: result.severity,
    });
  }

  // A provider outage means nothing was actually checked. Queue it so the gap
  // is visible rather than silently trusted.
  if (result.timed_out && input.subjectId) {
    await raiseFlag({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reason: 'Not checked: moderation provider unavailable.',
      severity: ModerationSeverity.low,
    });
  }

  return {
    check_id: record.id,
    severity: result.severity,
    should_warn: severityAtLeast(result.severity, WARN_THRESHOLD),
    // spec §5.4: advisory, not blocking. This is a constant, and it is a
    // constant deliberately — the day it becomes conditional, the product has
    // started blocking messages on a rules engine.
    can_send: true,
    findings: result.findings,
    timed_out: result.timed_out,
    provider: result.provider,
  };
}

function describe(findings: ModerationFinding[]): string {
  if (findings.length === 0) {
    return 'Flagged by moderation.';
  }

  return findings
    .map((finding) => finding.category)
    .join(', ')
    .slice(0, 200);
}

export interface RaiseFlagInput {
  subjectType: string;
  subjectId: string;
  reason: string;
  severity: ModerationSeverity;
}

/**
 * Adds to the moderation team's queue.
 *
 * Distinct from a Report: reports come from users, flags come from the system.
 * Keeping them apart matters because they need different triage — a report has
 * a human behind it who is waiting for an outcome.
 *
 * Idempotent per open flag on a subject, so a message scanned twice does not
 * produce two identical items in the queue.
 */
export async function raiseFlag(input: RaiseFlagInput): Promise<void> {
  const existing = await prisma.moderationFlag.findFirst({
    where: {
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      status: { in: [ReportStatus.open, ReportStatus.under_review] },
    },
    select: { id: true, severity: true },
  });

  if (existing) {
    // Raise the severity if this scan found something worse, but never lower
    // it — a later benign scan must not quiet an earlier serious finding.
    if (
      severityAtLeast(input.severity, existing.severity) &&
      input.severity !== existing.severity
    ) {
      await prisma.moderationFlag.update({
        where: { id: existing.id },
        data: { severity: input.severity, reason: input.reason },
      });
    }
    return;
  }

  await prisma.moderationFlag.create({
    data: {
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      reason: input.reason,
      severity: input.severity,
    },
  });

  logger.info(
    { subject_type: input.subjectType, severity: input.severity },
    'moderation flag raised',
  );
}

/**
 * Post-hoc scan of content that is already live (spec §7, Batch 10).
 *
 * Runs after the fact, on a queue, for everything the pre-send check cannot
 * cover: media the provider cannot read, content written before this batch
 * existed, and messages sent while the provider was down.
 */
export async function scanSubject(options: {
  userId: string;
  subjectType: string;
  subjectId: string;
  content: string | null;
}): Promise<ModerationSeverity> {
  // A provider that cannot assess this kind of subject must not mark it clean.
  // Queue it for a person instead — a queue that looks healthy while nothing is
  // being checked is worse than no queue.
  if (!provider.supports(options.subjectType) || options.content === null) {
    await raiseFlag({
      subjectType: options.subjectType,
      subjectId: options.subjectId,
      reason: `Awaiting human review: ${provider.name} cannot assess ${options.subjectType}.`,
      severity: ModerationSeverity.low,
    });

    return ModerationSeverity.none;
  }

  const result = await withTimeout(options.content);

  if (severityAtLeast(result.severity, FLAG_THRESHOLD)) {
    await raiseFlag({
      subjectType: options.subjectType,
      subjectId: options.subjectId,
      reason: describe(result.findings),
      severity: result.severity,
    });
  }

  return result.severity;
}

export interface FlagView {
  id: string;
  subject_type: string;
  subject_id: string;
  reason: string;
  severity: ModerationSeverity;
  status: ReportStatus;
  assigned_to_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

function toFlagView(flag: {
  id: string;
  subject_type: string;
  subject_id: string;
  reason: string;
  severity: ModerationSeverity;
  status: ReportStatus;
  assigned_to_id: string | null;
  resolved_at: Date | null;
  created_at: Date;
}): FlagView {
  return {
    id: flag.id,
    subject_type: flag.subject_type,
    subject_id: flag.subject_id,
    reason: flag.reason,
    severity: flag.severity,
    status: flag.status,
    assigned_to_id: flag.assigned_to_id,
    resolved_at: flag.resolved_at?.toISOString() ?? null,
    created_at: flag.created_at.toISOString(),
  };
}

export async function listFlags(options: {
  limit: number;
  cursor?: string;
  status?: ReportStatus;
  severity?: ModerationSeverity;
}) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.moderationFlag.findMany({
    where: {
      ...(options.status ? { status: options.status } : {}),
      ...(options.severity ? { severity: options.severity } : {}),
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
  });

  const page = paginate(rows, options.limit, (flag) => ({
    k: flag.created_at.toISOString(),
    id: flag.id,
  }));

  return {
    flags: page.items.map(toFlagView),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export async function resolveFlag(
  moderatorId: string,
  flagId: string,
  status: ReportStatus,
): Promise<FlagView> {
  const flag = await prisma.moderationFlag.findUnique({ where: { id: flagId } });

  if (!flag) {
    throw ApiError.notFound();
  }

  const updated = await prisma.moderationFlag.update({
    where: { id: flagId },
    data: {
      status,
      assigned_to_id: moderatorId,
      resolved_at:
        status === ReportStatus.actioned || status === ReportStatus.dismissed ? new Date() : null,
    },
  });

  logger.info({ flag_id: flagId, status }, 'moderation flag resolved');

  return toFlagView(updated);
}

export { FLAG_THRESHOLD, WARN_THRESHOLD, PROVIDER_TIMEOUT_MS };
