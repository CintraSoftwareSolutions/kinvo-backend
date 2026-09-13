import { MediaKind, type ReportReason, ReportStatus, prisma } from '@/db/prisma';
import { claimAsset } from '@modules/media/media.service';
import { ApiError } from '@utils/api-error';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';
import { blockUser } from './blocks.service';

/**
 * Reports (spec §5.7, Batch 12).
 *
 * THE RULE THAT SHAPES THIS FILE: reports are ANONYMOUS. The reported user must
 * never learn who reported them through any endpoint, notification, or error
 * message.
 *
 * That is why nothing here returns a report to the person it is about, why the
 * moderation queue is the only read path, and why submitting a report answers
 * the same way whether or not the target has already been reported — a
 * different response would let someone probe who has reports against them.
 */

export interface CreateReportInput {
  reporterId: string;
  reportedId: string;
  reason: ReportReason;
  description?: string;
  contextType?: string;
  contextId?: string;
  /** spec §5.7: blocks atomically on submit. */
  alsoBlock?: boolean;
  /** Completed uploads of kind `report_evidence`. */
  evidenceAssetIds?: string[];
}

export interface ReportView {
  id: string;
  reason: ReportReason;
  status: ReportStatus;
  also_blocked: boolean;
  evidence_count: number;
  created_at: string;
}

/**
 * Files a report, optionally blocking in the same transaction.
 *
 * "Atomically" in the spec is load-bearing: someone reporting harassment and
 * ticking block must not end up with the report filed and the block missing
 * because a write failed in between. They are one transaction or neither
 * happens.
 */
export async function createReport(input: CreateReportInput): Promise<ReportView> {
  if (input.reporterId === input.reportedId) {
    throw ApiError.validation({ reported_id: ['You cannot report yourself.'] });
  }

  const target = await prisma.user.findFirst({
    where: { id: input.reportedId, deleted_at: null },
    select: { id: true },
  });

  // 404 for a user who does not exist, is deleted, or was never visible. NOT
  // filtered by the block clause: someone must be able to report a person they
  // have already blocked, which is the most common order of events.
  if (!target) {
    throw ApiError.notFound();
  }

  // Evidence is claimed BEFORE the transaction. claimAsset checks ownership,
  // completion, and kind together, so a verification document can never be
  // attached as report evidence — and a failure here must not leave a report
  // half-written.
  const evidenceIds: string[] = [];

  for (const assetId of input.evidenceAssetIds ?? []) {
    const claimed = await claimAsset({
      userId: input.reporterId,
      assetId,
      expectedKind: MediaKind.report_evidence,
    });

    evidenceIds.push(claimed.id);
  }

  const report = await prisma.$transaction(async (tx) => {
    const created = await tx.report.create({
      data: {
        reporter_id: input.reporterId,
        reported_id: input.reportedId,
        reason: input.reason,
        description: input.description ?? null,
        context_type: input.contextType ?? null,
        context_id: input.contextId ?? null,
        also_block: input.alsoBlock ?? false,
        evidence: {
          create: evidenceIds.map((mediaAssetId) => ({ media_asset_id: mediaAssetId })),
        },
      },
      include: { evidence: { select: { id: true } } },
    });

    if (input.alsoBlock) {
      await blockUser(tx, input.reporterId, input.reportedId);
    }

    return created;
  });

  // Logged without the reporter id. Spec §5.7 is about what the reported user
  // can learn, and a log line naming both sides is one support-ticket
  // screenshot away from telling them.
  logger.info({ report_id: report.id, reason: input.reason }, 'report filed');

  return {
    id: report.id,
    reason: report.reason,
    status: report.status,
    also_blocked: report.also_block,
    evidence_count: report.evidence.length,
    created_at: report.created_at.toISOString(),
  };
}

/**
 * The reports this user has FILED. Never the reports about them.
 *
 * There is deliberately no endpoint that lists reports against a user. Even
 * a count would tell someone they are under review, which is enough to change
 * behaviour before a moderator looks.
 */
export async function listMyReports(
  reporterId: string,
  options: { limit: number; cursor?: string },
) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.report.findMany({
    where: {
      reporter_id: reporterId,
      deleted_at: null,
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
    include: { evidence: { select: { id: true } } },
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  return {
    reports: page.items.map((report) => ({
      id: report.id,
      reason: report.reason,
      status: report.status,
      also_blocked: report.also_block,
      evidence_count: report.evidence.length,
      created_at: report.created_at.toISOString(),
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

type ReportRow = {
  id: string;
  reason: ReportReason;
  status: ReportStatus;
  also_block: boolean;
  created_at: Date;
  reporter_id: string;
  reported_id: string;
  description: string | null;
  context_type: string | null;
  context_id: string | null;
  reviewed_at: Date | null;
  resolution_note: string | null;
  evidence: { id: string }[];
};

export interface AdminReportView extends ReportView {
  reporter_id: string;
  reported_id: string;
  description: string | null;
  context_type: string | null;
  context_id: string | null;
  reviewed_at: string | null;
  resolution_note: string | null;
}

/**
 * The moderation queue's view, which DOES include the reporter.
 *
 * Moderators need it to spot coordinated reporting and retaliation. This is the
 * only place the reporter's identity is returned, and it is behind a role gate.
 */
export async function listReportsForReview(options: {
  limit: number;
  cursor?: string;
  status?: ReportStatus;
  reason?: ReportReason;
}) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.report.findMany({
    where: {
      deleted_at: null,
      ...(options.status ? { status: options.status } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
    include: { evidence: { select: { id: true } } },
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  return {
    reports: page.items.map(toAdminView),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

/** Typed to what it reads rather than the full row, so callers stay free to
 * select only the evidence ids they need. */
function toAdminView(report: ReportRow): AdminReportView {
  return {
    id: report.id,
    reason: report.reason,
    status: report.status,
    also_blocked: report.also_block,
    evidence_count: report.evidence.length,
    created_at: report.created_at.toISOString(),
    reporter_id: report.reporter_id,
    reported_id: report.reported_id,
    description: report.description,
    context_type: report.context_type,
    context_id: report.context_id,
    reviewed_at: report.reviewed_at?.toISOString() ?? null,
    resolution_note: report.resolution_note,
  };
}

export async function resolveReport(
  moderatorId: string,
  reportId: string,
  input: { status: ReportStatus; resolution_note?: string },
): Promise<AdminReportView> {
  const report = await prisma.report.findFirst({
    where: { id: reportId, deleted_at: null },
    select: { id: true },
  });

  if (!report) {
    throw ApiError.notFound();
  }

  const updated = await prisma.report.update({
    where: { id: reportId },
    data: {
      status: input.status,
      resolution_note: input.resolution_note ?? null,
      reviewed_by_id: moderatorId,
      reviewed_at:
        input.status === ReportStatus.actioned || input.status === ReportStatus.dismissed
          ? new Date()
          : null,
    },
    include: { evidence: { select: { id: true } } },
  });

  logger.info({ report_id: reportId, status: input.status }, 'report resolved');

  return toAdminView(updated);
}
