import { randomUUID } from 'node:crypto';

import {
  CallKind,
  CallSafetyActionType,
  CallStatus,
  type Mode,
  type Prisma,
  ReportReason,
  prisma,
} from '@/db/prisma';
import { isPairReachable, otherUserId } from '@modules/matches/matches.service';
import { notify } from '@modules/notifications/notifications.service';
import { countEmailed, deliverySummary, emailContacts } from '@modules/safety/contact-alerts';
import { createReport } from '@modules/safety/reports.service';
import { callUpdateEmail } from '@modules/safety/safety.emails';
import {
  emitCallAnswered,
  emitCallDeclined,
  emitCallEnded,
  emitCallIncoming,
} from '@/realtime/emit';
import { getVideoProvider, type VideoToken } from '@/providers/video.provider';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { decodeCursor, paginate } from '@utils/cursor';
import { logger } from '@utils/logger';

const REQUIRE_VERIFICATION_TO_CALL = false;

const RINGING_TIMEOUT_MS = 60 * 1000;

const PARTICIPANT_SELECT = {
  ...USER_COMPACT_SELECT,
  deleted_at: true,
  status: true,
} as const;

const CALL_INCLUDE = {
  match: {
    select: {
      id: true,
      mode: true,
      status: true,
      expires_at: true,
      user_a_id: true,
      user_b_id: true,
      user_a: { select: PARTICIPANT_SELECT },
      user_b: { select: PARTICIPANT_SELECT },
    },
  },
} satisfies Prisma.CallSessionInclude;

type CallRow = Prisma.CallSessionGetPayload<{ include: typeof CALL_INCLUDE }>;

export interface CallView {
  id: string;
  match_id: string;
  mode: Mode;
  status: CallStatus;
  kind: CallKind;
  is_initiator: boolean;
  other_user: UserCompact;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface CallWithToken extends CallView {
  video: {
    room_name: string;
    token: string;
    server_url: string | null;
    expires_at: string;
  };
}

function isStale(call: { status: CallStatus; created_at: Date }, now = new Date()): boolean {
  return (
    call.status === CallStatus.ringing &&
    now.getTime() - call.created_at.getTime() > RINGING_TIMEOUT_MS
  );
}

function participantsOf(call: CallRow, viewerId: string) {
  const other = call.match.user_a_id === viewerId ? call.match.user_b : call.match.user_a;
  return { other, otherId: other.id };
}

function toView(call: CallRow, viewerId: string, otherUser: UserCompact): CallView {
  return {
    id: call.id,
    match_id: call.match_id,
    mode: call.match.mode,
    kind: call.kind,
    // A stale ringing row reads as `missed` even before the sweep rewrites it,
    // so the history list never shows a call as still ringing.
    status: isStale(call) ? CallStatus.missed : call.status,
    is_initiator: call.initiator_id === viewerId,
    other_user: otherUser,
    started_at: call.started_at?.toISOString() ?? null,
    answered_at: call.answered_at?.toISOString() ?? null,
    ended_at: call.ended_at?.toISOString() ?? null,
    duration_seconds: call.duration_seconds,
    created_at: call.created_at.toISOString(),
  };
}

type ParticipantRow = Prisma.UserGetPayload<{ select: typeof PARTICIPANT_SELECT }>;

async function compactFor(user: ParticipantRow): Promise<UserCompact> {
  const photoUrls = await getPrimaryPhotoUrlsFor([user.id]);
  return toUserCompact(user, photoUrls.get(user.id) ?? null);
}

async function loadParticipating(viewerId: string, callId: string): Promise<CallRow> {
  const call = await prisma.callSession.findFirst({
    where: {
      id: callId,
      match: { OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }] },
    },
    include: CALL_INCLUDE,
  });

  if (!call) {
    throw ApiError.notFound('That call does not exist.');
  }

  return call;
}

export async function startCall(
  userId: string,
  matchId: string,
  kind: CallKind = CallKind.video,
): Promise<CallWithToken> {
  const match = await prisma.match.findFirst({
    where: { id: matchId, OR: [{ user_a_id: userId }, { user_b_id: userId }] },
    select: {
      id: true,
      mode: true,
      status: true,
      expires_at: true,
      user_a_id: true,
      user_b_id: true,
      user_a: { select: PARTICIPANT_SELECT },
      user_b: { select: PARTICIPANT_SELECT },
    },
  });

  if (!match) {
    throw ApiError.notFound('That match does not exist.');
  }

  const other = match.user_a_id === userId ? match.user_b : match.user_a;

  if (!(await isPairReachable(match, userId, other))) {
    // Deliberately the same message for every reason — blocked, unmatched,
    // expired, account gone. Telling them apart confirms a block by
    // elimination (spec §4.4, §5.5).
    throw ApiError.notFound('That match does not exist.');
  }

  if (REQUIRE_VERIFICATION_TO_CALL) {
    const both = await prisma.user.count({
      where: { id: { in: [userId, other.id] }, is_verified: true },
    });

    if (both < 2) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, 'Both people need a verified profile to call.');
    }
  }

  // An existing live call is returned rather than duplicated. Two rows for one
  // conversation would mean two rooms, and the pair would sit in different
  // ones wondering why they cannot hear each other.
  const existing = await prisma.callSession.findFirst({
    where: {
      match_id: matchId,
      status: { in: [CallStatus.ringing, CallStatus.active] },
    },
    include: CALL_INCLUDE,
  });

  if (existing && !isStale(existing)) {
    return withToken(existing, userId, await compactFor(participantsOf(existing, userId).other));
  }

  const callId = randomUUID();

  const created = await prisma.callSession.create({
    data: {
      id: callId,
      match_id: matchId,
      initiator_id: userId,
      room_name: getVideoProvider().roomNameFor(callId),
      status: CallStatus.ringing,
      // Stored, not held on the caller's phone: the ringing phone decides
      // whether to open its camera, and this is all it has to go on.
      kind,
      started_at: new Date(),
    },
    include: CALL_INCLUDE,
  });

  const otherCompact = await compactFor(other);
  const view = await withToken(created, userId, otherCompact);

  emitCallIncoming(other.id, {
    call_id: created.id,
    match_id: matchId,
    mode: match.mode,
    kind: created.kind,
    from: await compactFor(match.user_a_id === userId ? match.user_a : match.user_b),
  });

  await notify({
    userId: other.id,
    category: 'call',
    title: created.kind === CallKind.audio ? 'Incoming voice call' : 'Incoming call',
    body: 'Someone you matched with is calling.',
    data: { call_id: created.id, match_id: matchId, mode: match.mode, kind: created.kind },
  });

  logger.info(
    { call_id: created.id, match_id: matchId, mode: match.mode, kind: created.kind },
    'call started',
  );

  return view;
}

async function withToken(
  call: CallRow,
  viewerId: string,
  otherUser: UserCompact,
): Promise<CallWithToken> {
  const token = await issueFor(call, viewerId);

  return {
    ...toView(call, viewerId, otherUser),
    video: {
      room_name: token.room_name,
      token: token.token,
      server_url: token.server_url,
      expires_at: token.expires_at.toISOString(),
    },
  };
}

function issueFor(call: { room_name: string }, userId: string): Promise<VideoToken> {
  return getVideoProvider().issueToken({ roomName: call.room_name, userId });
}

function closeRoomFor(call: { id: string; room_name: string }): void {
  void getVideoProvider()
    .closeRoom(call.room_name)
    .catch((error: unknown) => {
      logger.warn({ err: error, call_id: call.id }, 'could not close the video room');
    });
}

export async function answerCall(userId: string, callId: string): Promise<CallWithToken> {
  const call = await loadParticipating(userId, callId);

  if (call.initiator_id === userId) {
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'You started this call.');
  }

  if (call.status !== CallStatus.ringing || isStale(call)) {
    // Covers answering a call that was already declined, ended, or rang out.
    throw new ApiError(ERROR_CODES.CONFLICT, 'That call is no longer ringing.');
  }

  const { other, otherId } = participantsOf(call, userId);

  if (!(await isPairReachable(call.match, userId, other))) {
    throw ApiError.notFound('That call does not exist.');
  }

  const answered = await prisma.callSession.update({
    where: { id: call.id },
    data: { status: CallStatus.active, answered_at: new Date() },
    include: CALL_INCLUDE,
  });

  emitCallAnswered(otherId, call.id);

  logger.info({ call_id: call.id }, 'call answered');

  return withToken(answered, userId, await compactFor(other));
}

export async function declineCall(userId: string, callId: string): Promise<CallView> {
  const call = await loadParticipating(userId, callId);

  if (call.initiator_id === userId) {
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'You started this call.');
  }

  if (call.status !== CallStatus.ringing) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That call is no longer ringing.');
  }

  const { other, otherId } = participantsOf(call, userId);

  const declined = await prisma.callSession.update({
    where: { id: call.id },
    data: { status: CallStatus.declined, ended_at: new Date() },
    include: CALL_INCLUDE,
  });

  emitCallDeclined(otherId, call.id);

  // The caller has been sitting in the room since it started ringing.
  closeRoomFor(call);

  return toView(declined, userId, await compactFor(other));
}

export async function endCall(userId: string, callId: string): Promise<CallView> {
  const call = await loadParticipating(userId, callId);

  if (call.status === CallStatus.ended || call.status === CallStatus.declined) {
    // Idempotent: both apps may send an end on hang-up, and the second must not
    // be an error the user sees.
    return toView(call, userId, await compactFor(participantsOf(call, userId).other));
  }

  const now = new Date();
  const { other, otherId } = participantsOf(call, userId);

  const ended = await prisma.callSession.update({
    where: { id: call.id },
    data: {
      status: call.answered_at ? CallStatus.ended : CallStatus.missed,
      ended_at: now,
      ended_by_id: userId,
      duration_seconds: call.answered_at
        ? Math.max(0, Math.round((now.getTime() - call.answered_at.getTime()) / 1000))
        : null,
    },
    include: CALL_INCLUDE,
  });

  emitCallEnded(otherId, call.id, ended.duration_seconds);

  // Both sides have been told, but "told" is not "gone": an app that ignores
  // the event, or was closed with the media still running, keeps the camera up
  // until the room itself goes. This is what makes hanging up — and `end and
  // report` above all — actually end the picture.
  closeRoomFor(call);

  logger.info({ call_id: call.id, duration_seconds: ended.duration_seconds }, 'call ended');

  return toView(ended, userId, await compactFor(other));
}

export async function issueCallToken(userId: string, callId: string): Promise<CallWithToken> {
  const call = await loadParticipating(userId, callId);

  if (isStale(call) || (call.status !== CallStatus.ringing && call.status !== CallStatus.active)) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'That call is not live.');
  }

  const { other } = participantsOf(call, userId);

  // Re-checked on every issue, not just at the start. A block placed mid-call
  // has to stop the next reconnect, or blocking someone who is on your screen
  // would do nothing until they hung up.
  if (!(await isPairReachable(call.match, userId, other))) {
    throw ApiError.notFound('That call does not exist.');
  }

  return withToken(call, userId, await compactFor(other));
}

export async function listCalls(
  userId: string,
  options: { limit: number; cursor?: string },
): Promise<{
  calls: CallView[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.callSession.findMany({
    where: {
      match: { OR: [{ user_a_id: userId }, { user_b_id: userId }] },
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
    include: CALL_INCLUDE,
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  // One presign call for the whole page, not one per row (spec §4.7).
  const others = page.items.map((row) => participantsOf(row, userId).other);
  const photoUrls = await getPrimaryPhotoUrlsFor(others.map((user) => user.id));

  return {
    calls: page.items.map((row, index) => {
      const other = others[index]!;
      return toView(row, userId, toUserCompact(other, photoUrls.get(other.id) ?? null));
    }),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export interface SafetyActionResult {
  call_id: string;
  action: CallSafetyActionType;
  /** Set when the action ended the call too. */
  call_status: CallStatus;
  report_id: string | null;
}

const CALL_UPDATES_PER_HOUR = 5;

export async function recordSafetyAction(
  userId: string,
  callId: string,
  input: { action: CallSafetyActionType; note?: string },
): Promise<SafetyActionResult> {
  const call = await loadParticipating(userId, callId);
  const { other, otherId } = participantsOf(call, userId);

  await prisma.callSafetyAction.create({
    data: {
      call_id: call.id,
      user_id: userId,
      action: input.action,
      note: input.note ?? null,
    },
  });

  logger.warn({ call_id: call.id, action: input.action }, 'in-call safety action');

  let reportId: string | null = null;
  let status = call.status;

  if (input.action === CallSafetyActionType.end_and_report) {
    // Ends FIRST. Someone reaching for this wants the call to stop; a report
    // that succeeded while the call carried on would be the wrong half.
    status = (await endCall(userId, call.id)).status;

    const report = await createReport({
      reporterId: userId,
      reportedId: otherId,
      reason: ReportReason.safety_concern,
      description: input.note,
      contextType: 'call',
      contextId: call.id,
    });

    reportId = report.id;
  }

  if (input.action === CallSafetyActionType.send_live_update) {
    const [sentThisHour, user, contacts] = await Promise.all([
      prisma.callSafetyAction.count({
        where: {
          user_id: userId,
          action: CallSafetyActionType.send_live_update,
          created_at: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { display_name: true } }),
      prisma.trustedContact.findMany({
        where: { user_id: userId },
        select: { id: true, name: true, email: true },
      }),
    ]);

    const withinCap = sentThisHour <= CALL_UPDATES_PER_HOUR;
    const alerts = withinCap
      ? await emailContacts(contacts, (contact) =>
          callUpdateEmail({
            to: contact.email,
            contactName: contact.name,
            senderName: user?.display_name ?? 'Someone you know',
            withName: other.display_name,
          }),
        )
      : [];

    await notify({
      userId,
      category: 'safety',
      title: countEmailed(alerts) > 0 ? 'Update sent' : 'Nobody was emailed',
      body: withinCap
        ? deliverySummary(alerts)
        : "You've sent several updates in the last hour, so your contacts weren't emailed again.",
      data: { call_id: call.id },
    });
  }

  return { call_id: call.id, action: input.action, call_status: status, report_id: reportId };
}

export async function sweepRingingCalls(now: Date = new Date()): Promise<number> {
  const result = await prisma.callSession.updateMany({
    where: {
      status: CallStatus.ringing,
      created_at: { lt: new Date(now.getTime() - RINGING_TIMEOUT_MS) },
    },
    data: { status: CallStatus.missed, ended_at: now },
  });

  return result.count;
}

const MAX_CALL_DURATION_MS = 4 * 60 * 60 * 1000;
const ROOM_ENDED = 'room-ended';

export async function applyRoomEvent(event: {
  type: string;
  roomName: string;
}): Promise<{ applied: boolean }> {
  if (event.type !== ROOM_ENDED) {
    // Participant joins and leaves are not state changes we store. Logged at
    // debug rather than ignored silently, so an unexpected event type is
    // findable without being noisy.
    logger.debug({ event: event.type, room: event.roomName }, 'video callback ignored');
    return { applied: false };
  }

  const call = await prisma.callSession.findUnique({
    where: { room_name: event.roomName },
    include: CALL_INCLUDE,
  });

  if (!call) {
    logger.warn({ room: event.roomName }, 'video callback for an unknown room');
    return { applied: false };
  }

  if (call.status !== CallStatus.ringing && call.status !== CallStatus.active) {
    return { applied: false };
  }

  const now = new Date();

  const ended = await prisma.callSession.update({
    where: { id: call.id },
    data: {
      status: call.answered_at ? CallStatus.ended : CallStatus.missed,
      ended_at: now,
      // Nobody hung up — the room ended. Leaving this null is the honest
      // record, and the app shows "call ended" rather than naming a person.
      ended_by_id: null,
      duration_seconds: call.answered_at
        ? Math.max(0, Math.round((now.getTime() - call.answered_at.getTime()) / 1000))
        : null,
    },
    include: CALL_INCLUDE,
  });

  // Both sides, because neither of them is the one who ended it.
  for (const participant of [ended.match.user_a, ended.match.user_b]) {
    emitCallEnded(participant.id, ended.id, ended.duration_seconds);
  }

  logger.info(
    { call_id: ended.id, duration_seconds: ended.duration_seconds },
    'call ended by provider callback',
  );

  return { applied: true };
}

export async function sweepStuckCalls(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MAX_CALL_DURATION_MS);

  const stuck = await prisma.callSession.findMany({
    where: {
      status: CallStatus.active,
      // Measured from when it was answered, matching how duration is measured.
      answered_at: { lt: cutoff },
    },
    select: { id: true, answered_at: true, room_name: true },
  });

  if (stuck.length === 0) {
    return 0;
  }

  for (const call of stuck) {
    await prisma.callSession.update({
      where: { id: call.id },
      data: {
        status: CallStatus.ended,
        ended_at: now,
        ended_by_id: null,
        duration_seconds: call.answered_at
          ? Math.max(0, Math.round((now.getTime() - call.answered_at.getTime()) / 1000))
          : null,
      },
    });

    // If the provider never told us the room ended, it may still be open with
    // a stuck client in it. Closing the row and leaving the room up would be
    // half the job.
    closeRoomFor(call);
  }

  logger.info({ count: stuck.length }, 'closed abandoned calls');

  return stuck.length;
}

export { RINGING_TIMEOUT_MS, MAX_CALL_DURATION_MS, REQUIRE_VERIFICATION_TO_CALL, otherUserId };
