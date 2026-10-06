import {
  ModerationSeverity,
  type Prisma,
  ReportStatus,
  type Mode,
  type ReportReason,
  type VenueCategory,
  prisma,
} from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { decodeCursor, paginate } from '@utils/cursor';
import { ERROR_CODES } from '@utils/error-codes';
import { setVenueLocationTx } from '@/db/geo';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { writeAudit } from './admin.service';

/**
 * Content moderation and venue curation for the admin panel (Batch 15).
 *
 * THE PRIVACY LINE, which is the most important thing in this file. The queue
 * tells an operator THAT something was reported, by whom it was reported about,
 * for what reason, and how severe the automated scan thought it was. It does
 * NOT return the reported message's text.
 *
 * That is deliberate and it is the expensive-to-reverse decision. An admin
 * endpoint that returns conversation content on request is the largest privacy
 * surface in the product — it would let any staff account read any two people's
 * chat with no reason recorded. Reading content needs a justification attached
 * to a specific report, which is a different endpoint with a different audit
 * entry, and it is not built here.
 *
 * `/reports/review` and `/moderation/flags` already exist and are UNTOUCHED.
 * These are the panel's richer views over the same rows, which is why they add
 * reading and assignment rather than re-implementing resolution.
 */

// ---------------------------------------------------------------------------
// Moderation queue
// ---------------------------------------------------------------------------

export interface ModerationQueueRow {
  id: string;
  /** What kind of row this is: a human report, or an automated flag. */
  source: 'report' | 'flag';
  reportedName: string;
  userId: string;
  avatar: string | null;
  reason: string;
  mode: string;
  severity: 'High' | 'Medium' | 'Low';
  timestamp: string;
  status: ReportStatus;
  assignedToId: string | null;
  /** Null for a flag; a report names what was reported about. */
  contextType: string | null;
}

/**
 * The panel renders three severities; the enum has five.
 *
 * `critical` collapses UP into High rather than being dropped, and `none` down
 * into Low. Dropping either would silently hide rows — and `critical` is
 * exactly the row an operator must not miss.
 */
function severityLabel(severity: ModerationSeverity): 'High' | 'Medium' | 'Low' {
  if (severity === ModerationSeverity.critical || severity === ModerationSeverity.high) {
    return 'High';
  }

  return severity === ModerationSeverity.medium ? 'Medium' : 'Low';
}

/**
 * Reports carry a reason but no severity, so one is inferred from the reason.
 * Safety of a person outranks money, which outranks nuisance.
 *
 * TYPED AS A TOTAL RECORD, deliberately. A loose `Record<string, …>` with a
 * fallback compiles happily while naming reasons that do not exist — which is
 * precisely what an earlier version of this file did, so every report in the
 * queue read as Medium and the triage order was meaningless. Adding a reason to
 * the enum must be a compile error here, not a silent default.
 */
const REPORT_SEVERITY: Record<ReportReason, 'High' | 'Medium' | 'Low'> = {
  safety_concern: 'High',
  harassment: 'High',
  // Money rather than physical safety. Serious, and the scam rules are
  // globally scoped for it (spec §1), but it is not someone in danger.
  spam_scam: 'Medium',
  fake_profile: 'Low',
};

function modeLabel(mode: string): string {
  return mode
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface ModerationQueueOptions {
  status?: ReportStatus;
  severity?: 'High' | 'Medium' | 'Low';
  assignedToId?: string;
  unassigned?: boolean;
  limit: number;
  cursor?: string;
}

export async function moderationQueue(options: ModerationQueueOptions): Promise<{
  items: ModerationQueueRow[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const status = options.status ?? ReportStatus.open;

  // Reports and flags are different tables with no shared key, so both are
  // fetched and merged in memory. Each is bounded by the page size, so the
  // merge never grows with the table.
  const [reports, flags] = await Promise.all([
    prisma.report.findMany({
      where: {
        status,
        deleted_at: null,
        ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: options.limit + 1,
      select: {
        id: true,
        reason: true,
        status: true,
        context_type: true,
        created_at: true,
        reviewed_by_id: true,
        reported: {
          select: {
            id: true,
            display_name: true,
            user_modes: {
              where: { is_enabled: true, is_primary: true },
              select: { mode: true },
              take: 1,
            },
          },
        },
      },
    }),
    prisma.moderationFlag.findMany({
      where: {
        status,
        subject_type: 'user',
        ...(options.severity === 'High'
          ? { severity: { in: [ModerationSeverity.high, ModerationSeverity.critical] } }
          : {}),
        ...(options.assignedToId ? { assigned_to_id: options.assignedToId } : {}),
        ...(options.unassigned ? { assigned_to_id: null } : {}),
        ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: options.limit + 1,
      select: {
        id: true,
        subject_id: true,
        reason: true,
        severity: true,
        status: true,
        assigned_to_id: true,
        created_at: true,
      },
    }),
  ]);

  const flagSubjects = await prisma.user.findMany({
    where: { id: { in: flags.map((flag) => flag.subject_id) } },
    select: {
      id: true,
      display_name: true,
      user_modes: {
        where: { is_enabled: true, is_primary: true },
        select: { mode: true },
        take: 1,
      },
    },
  });

  const subjectById = new Map(flagSubjects.map((user) => [user.id, user]));

  const merged: (ModerationQueueRow & { sortKey: Date })[] = [
    ...reports.map((report) => ({
      id: report.id,
      source: 'report' as const,
      reportedName: report.reported.display_name,
      userId: report.reported.id,
      avatar: null,
      reason: report.reason,
      mode: report.reported.user_modes[0]
        ? modeLabel(report.reported.user_modes[0].mode)
        : '—',
      severity: REPORT_SEVERITY[report.reason],
      timestamp: report.created_at.toISOString(),
      status: report.status,
      assignedToId: report.reviewed_by_id,
      contextType: report.context_type,
      sortKey: report.created_at,
    })),
    ...flags.flatMap((flag) => {
      const subject = subjectById.get(flag.subject_id);

      if (!subject) {
        // The account was erased after the flag was raised. Skipped rather
        // than rendered as a blank row an operator cannot act on.
        return [];
      }

      return [
        {
          id: flag.id,
          source: 'flag' as const,
          reportedName: subject.display_name,
          userId: subject.id,
          avatar: null,
          reason: flag.reason,
          mode: subject.user_modes[0] ? modeLabel(subject.user_modes[0].mode) : '—',
          severity: severityLabel(flag.severity),
          timestamp: flag.created_at.toISOString(),
          status: flag.status,
          assignedToId: flag.assigned_to_id,
          contextType: null,
          sortKey: flag.created_at,
        },
      ];
    }),
  ];

  const filtered = options.severity
    ? merged.filter((row) => row.severity === options.severity)
    : merged;

  filtered.sort((a, b) => b.sortKey.getTime() - a.sortKey.getTime());

  const page = paginate(filtered, options.limit, (row) => ({
    k: row.sortKey.toISOString(),
    id: row.id,
  }));

  const photoUrls = await getPrimaryPhotoUrlsFor(page.items.map((row) => row.userId));

  return {
    items: page.items.map(({ sortKey: _sortKey, ...row }) => ({
      ...row,
      avatar: photoUrls.get(row.userId) ?? null,
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

/**
 * Assigns a flag to a moderator, or clears the assignment.
 *
 * The column already existed and nothing wrote to it. Assignment is how two
 * moderators working the same queue avoid both acting on one row — the 409 on
 * a second decision catches it afterwards, this prevents the wasted work.
 */
export async function assignFlag(input: {
  flagId: string;
  assigneeId: string | null;
  adminId: string;
  ipAddress?: string | null;
}): Promise<{ id: string; assignedToId: string | null }> {
  const flag = await prisma.moderationFlag.findUnique({
    where: { id: input.flagId },
    select: { id: true, status: true, assigned_to_id: true },
  });

  if (!flag) {
    throw ApiError.notFound('That flag does not exist.');
  }

  if (flag.status !== ReportStatus.open && flag.status !== ReportStatus.under_review) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That flag has already been resolved.');
  }

  if (input.assigneeId) {
    const assignee = await prisma.user.findFirst({
      where: { id: input.assigneeId, deleted_at: null, role: { not: 'user' } },
      select: { id: true },
    });

    if (!assignee) {
      // Only staff can own a queue row. Assigning to an ordinary account would
      // park the row with somebody who can never open it.
      throw new ApiError(ERROR_CODES.CONFLICT, 'Flags can only be assigned to staff.');
    }
  }

  const updated = await prisma.moderationFlag.update({
    where: { id: flag.id },
    data: {
      assigned_to_id: input.assigneeId,
      // Picking up a row moves it out of the unclaimed pile.
      status: input.assigneeId ? ReportStatus.under_review : ReportStatus.open,
    },
    select: { id: true, assigned_to_id: true },
  });

  await writeAudit({
    adminId: input.adminId,
    action: input.assigneeId ? 'flag.assign' : 'flag.unassign',
    targetType: 'moderation_flag',
    targetId: flag.id,
    metadata: { assignee_id: input.assigneeId },
    ipAddress: input.ipAddress,
  });

  return { id: updated.id, assignedToId: updated.assigned_to_id };
}

export interface ModerationInsights {
  queueHealth: { label: string; value: string; description?: string }[];
  weeklyLoad: { week: string; reports: number; resolved: number }[];
  reportedCategories: { reason: string; cases: number }[];
  owners: { id: string; name: string; openCases: number }[];
}

/**
 * The insights tab.
 *
 * Twelve weeks of load, counted from `created_at` and the resolution timestamp.
 * `resolved` counts reports that REACHED a decision in that week, not reports
 * raised that week which are now resolved — the second is a different question
 * and would make the two series incomparable.
 */
export interface PriorityCase {
  id: string;
  source: 'report' | 'flag';
  name: string;
  userId: string;
  reason: string;
  mode: string;
  /**
   * The REPORTER'S OWN words about why they filed it — not the reported
   * message. Null for an automated flag, which has no author to quote.
   *
   * Serving this is correct and the distinction is worth being precise about,
   * because an earlier version of this module withheld it on a privacy
   * argument that did not hold. The line is conversation CONTENT: no endpoint
   * returns a message somebody sent. A complaint somebody wrote in order to be
   * read by moderation is the opposite case — withholding it leaves a reviewer
   * with a name and an enum, which is not enough to act on, and the shipped
   * `/reports/review` has always returned it alongside the reporter's identity.
   */
  description: string | null;
  severity: 'High' | 'Medium';
  createdAt: string;
}

/**
 * The escalations tab: open cases that need a decision soon.
 *
 * ORDERED BY SEVERITY FIRST, then oldest within each band — the one list in
 * this module that is not purely oldest-first. A priority view whose first row
 * is a week-old Medium while a High waits below it is not a priority view. The
 * oldest-first rule still governs inside a band, so nothing gets stranded.
 *
 * `Low` is excluded by construction, not filtered late: this is the list for
 * cases that cannot wait, and padding it with the ones that can is how a
 * priority queue becomes the ordinary queue with a different title.
 */
export async function moderationEscalations(limit: number): Promise<PriorityCase[]> {
  const [reports, flags] = await Promise.all([
    prisma.report.findMany({
      where: {
        status: { in: [ReportStatus.open, ReportStatus.under_review] },
        deleted_at: null,
        // Only the reasons that infer to High or Medium. Done in the query
        // rather than by fetching everything and dropping Low afterwards,
        // which would make `limit` mean something different per page.
        reason: {
          in: (Object.keys(REPORT_SEVERITY) as ReportReason[]).filter(
            (reason) => REPORT_SEVERITY[reason] !== 'Low',
          ),
        },
      },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: {
        id: true,
        reason: true,
        description: true,
        created_at: true,
        reported: {
          select: {
            id: true,
            display_name: true,
            user_modes: {
              where: { is_enabled: true, is_primary: true },
              select: { mode: true },
              take: 1,
            },
          },
        },
      },
    }),
    prisma.moderationFlag.findMany({
      where: {
        status: { in: [ReportStatus.open, ReportStatus.under_review] },
        subject_type: 'user',
        severity: {
          in: [ModerationSeverity.critical, ModerationSeverity.high, ModerationSeverity.medium],
        },
      },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: {
        id: true,
        subject_id: true,
        reason: true,
        severity: true,
        created_at: true,
      },
    }),
  ]);

  const subjects = await prisma.user.findMany({
    where: { id: { in: flags.map((flag) => flag.subject_id) } },
    select: {
      id: true,
      display_name: true,
      user_modes: {
        where: { is_enabled: true, is_primary: true },
        select: { mode: true },
        take: 1,
      },
    },
  });

  const subjectById = new Map(subjects.map((user) => [user.id, user]));

  const cases: PriorityCase[] = [
    ...reports.map((report) => ({
      id: report.id,
      source: 'report' as const,
      name: report.reported.display_name,
      userId: report.reported.id,
      reason: report.reason,
      mode: report.reported.user_modes[0]
        ? modeLabel(report.reported.user_modes[0].mode)
        : '—',
      description: report.description,
      // Narrowed safely: the query already excluded every Low reason.
      severity: REPORT_SEVERITY[report.reason] as 'High' | 'Medium',
      createdAt: report.created_at.toISOString(),
    })),
    ...flags.flatMap((flag) => {
      const subject = subjectById.get(flag.subject_id);

      if (!subject) {
        return [];
      }

      return [
        {
          id: flag.id,
          source: 'flag' as const,
          name: subject.display_name,
          userId: subject.id,
          reason: flag.reason,
          mode: subject.user_modes[0] ? modeLabel(subject.user_modes[0].mode) : '—',
          // An automated finding has no author, so there is nothing to quote.
          // Null rather than a generated sentence — an invented description
          // reads to a reviewer exactly like something a person wrote.
          description: null,
          severity: severityLabel(flag.severity) as 'High' | 'Medium',
          createdAt: flag.created_at.toISOString(),
        },
      ];
    }),
  ];

  const rank = { High: 0, Medium: 1 } as const;

  cases.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );

  return cases.slice(0, limit);
}

export async function moderationInsights(): Promise<ModerationInsights> {
  const weeks = 12;
  const now = new Date();
  const windowStart = new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);

  const [open, underReview, totalResolved, raised, resolved, categories, owners] =
    await Promise.all([
      prisma.report.count({ where: { status: ReportStatus.open, deleted_at: null } }),
      prisma.report.count({ where: { status: ReportStatus.under_review, deleted_at: null } }),
      prisma.report.count({
        where: {
          status: { in: [ReportStatus.actioned, ReportStatus.dismissed] },
          deleted_at: null,
        },
      }),
      prisma.report.findMany({
        where: { created_at: { gte: windowStart }, deleted_at: null },
        select: { created_at: true },
      }),
      prisma.report.findMany({
        where: { reviewed_at: { gte: windowStart }, deleted_at: null },
        select: { reviewed_at: true },
      }),
      prisma.report.groupBy({
        by: ['reason'],
        where: { deleted_at: null },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 6,
      }),
      prisma.moderationFlag.groupBy({
        by: ['assigned_to_id'],
        where: {
          assigned_to_id: { not: null },
          status: { in: [ReportStatus.open, ReportStatus.under_review] },
        },
        _count: { id: true },
      }),
    ]);

  /** ISO week bucket, so both series land in the same keys. */
  const weekKey = (date: Date): string => {
    const monday = new Date(date);
    const day = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - day);
    return monday.toISOString().slice(0, 10);
  };

  const buckets = new Map<string, { reports: number; resolved: number }>();

  for (let index = weeks - 1; index >= 0; index -= 1) {
    const date = new Date(now.getTime() - index * 7 * 24 * 60 * 60 * 1000);
    buckets.set(weekKey(date), { reports: 0, resolved: 0 });
  }

  for (const row of raised) {
    const bucket = buckets.get(weekKey(row.created_at));
    if (bucket) {
      bucket.reports += 1;
    }
  }

  for (const row of resolved) {
    if (!row.reviewed_at) {
      continue;
    }
    const bucket = buckets.get(weekKey(row.reviewed_at));
    if (bucket) {
      bucket.resolved += 1;
    }
  }

  const ownerIds = owners
    .map((row) => row.assigned_to_id)
    .filter((id): id is string => id !== null);

  const ownerUsers = await prisma.user.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, display_name: true },
  });

  const ownerNames = new Map(ownerUsers.map((user) => [user.id, user.display_name]));

  return {
    queueHealth: [
      { label: 'Open', value: String(open), description: 'Waiting for a first look' },
      { label: 'Under review', value: String(underReview), description: 'Claimed by somebody' },
      { label: 'Resolved', value: String(totalResolved), description: 'All time' },
    ],
    weeklyLoad: [...buckets.entries()].map(([week, counts]) => ({ week, ...counts })),
    reportedCategories: categories.map((row) => ({
      reason: row.reason,
      cases: row._count.id,
    })),
    owners: ownerIds.flatMap((id) => {
      const name = ownerNames.get(id);
      const row = owners.find((entry) => entry.assigned_to_id === id);

      return name && row ? [{ id, name, openCases: row._count.id }] : [];
    }),
  };
}

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

export interface AdminVenueRow {
  id: string;
  name: string;
  category: VenueCategory;
  /** The panel's two-value union, derived from the two honest booleans. */
  status: 'Featured' | 'Pending review';
  is_featured: boolean;
  is_reviewed: boolean;
  is_active: boolean;
  city: string | null;
  country: string | null;
  modes: string[];
  rating: number | null;
  price_level: number | null;
  created_at: string;
}

function toVenueRow(venue: {
  id: string;
  name: string;
  category: VenueCategory;
  is_featured: boolean;
  is_reviewed: boolean;
  is_active: boolean;
  city: string | null;
  country: string | null;
  modes: string[];
  rating: number | null;
  price_level: number | null;
  created_at: Date;
}): AdminVenueRow {
  return {
    id: venue.id,
    name: venue.name,
    category: venue.category,
    // The panel offers only two labels for three independent facts, so this
    // collapses them and the booleans are returned alongside. "Pending review"
    // wins when unreviewed, because that is the row needing action.
    status: venue.is_reviewed && venue.is_featured ? 'Featured' : 'Pending review',
    is_featured: venue.is_featured,
    is_reviewed: venue.is_reviewed,
    is_active: venue.is_active,
    city: venue.city,
    country: venue.country,
    modes: venue.modes,
    rating: venue.rating,
    price_level: venue.price_level,
    created_at: venue.created_at.toISOString(),
  };
}

const VENUE_SELECT = {
  id: true,
  name: true,
  category: true,
  is_featured: true,
  is_reviewed: true,
  is_active: true,
  city: true,
  country: true,
  modes: true,
  rating: true,
  price_level: true,
  created_at: true,
} satisfies Prisma.VenueSelect;

export async function listVenues(options: {
  search?: string;
  category?: VenueCategory;
  featured?: boolean;
  reviewed?: boolean;
  active?: boolean;
  limit: number;
  cursor?: string;
}): Promise<{
  venues: AdminVenueRow[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.venue.findMany({
    where: {
      ...(options.search ? { name: { contains: options.search, mode: 'insensitive' } } : {}),
      ...(options.category ? { category: options.category } : {}),
      ...(options.featured === undefined ? {} : { is_featured: options.featured }),
      ...(options.reviewed === undefined ? {} : { is_reviewed: options.reviewed }),
      ...(options.active === undefined ? {} : { is_active: options.active }),
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    select: VENUE_SELECT,
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  return {
    venues: page.items.map(toVenueRow),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

/**
 * Creates a venue.
 *
 * COORDINATES ARE REQUIRED, and the insert and the spatial write commit
 * together. A venue with no location is worse than no venue: every suggestion
 * query is a radius query, so it would never be shown to anybody while sitting
 * in the panel's list looking perfectly fine.
 *
 * `is_reviewed` is forced true — an operator typing a venue in by hand IS the
 * review. `is_featured` is not accepted here: featuring is a separate decision
 * with its own audit entry, and bundling it into creation would mean a venue
 * reaching every user in the same request that first described it.
 */
export async function createVenue(input: {
  data: {
    name: string;
    category: VenueCategory;
    description?: string;
    address?: string;
    city?: string;
    country?: string;
    modes: Mode[];
    price_level?: number;
    longitude: number;
    latitude: number;
  };
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminVenueRow> {
  const { longitude, latitude, ...fields } = input.data;

  const created = await prisma.$transaction(async (tx) => {
    const venue = await tx.venue.create({
      data: { ...fields, is_reviewed: true },
      select: VENUE_SELECT,
    });

    await setVenueLocationTx(tx, venue.id, { longitude, latitude });

    return venue;
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'venue.create',
    targetType: 'venue',
    targetId: created.id,
    // The coordinates are recorded, because "who put this venue here" is the
    // question an audit log gets asked about a venue.
    metadata: { name: created.name, longitude, latitude },
    ipAddress: input.ipAddress,
  });

  return toVenueRow(created);
}

export async function updateVenue(input: {
  venueId: string;
  changes: {
    name?: string;
    description?: string;
    category?: VenueCategory;
    is_featured?: boolean;
    is_reviewed?: boolean;
    is_active?: boolean;
  };
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminVenueRow> {
  const venue = await prisma.venue.findUnique({
    where: { id: input.venueId },
    select: { id: true, is_featured: true, is_reviewed: true },
  });

  if (!venue) {
    throw ApiError.notFound('That venue does not exist.');
  }

  if (input.changes.is_featured === true && !(input.changes.is_reviewed ?? venue.is_reviewed)) {
    // Featuring promotes a venue into the app's suggestions. Doing that to
    // something nobody has looked at is how a user-submitted venue reaches
    // everyone unchecked.
    throw new ApiError(ERROR_CODES.CONFLICT, 'Review a venue before featuring it.');
  }

  const updated = await prisma.venue.update({
    where: { id: venue.id },
    data: input.changes,
    select: VENUE_SELECT,
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'venue.update',
    targetType: 'venue',
    targetId: venue.id,
    metadata: { ...input.changes },
    ipAddress: input.ipAddress,
  });

  return toVenueRow(updated);
}
