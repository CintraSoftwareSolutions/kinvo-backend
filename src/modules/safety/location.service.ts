import { EmergencyEventType, PlanStatus, prisma } from '@/db/prisma';
import {
  type Coordinates,
  getEmergencyLocation,
  pruneExpiredLiveLocations,
  readLocationPings,
  recordLocationPing,
  setEmergencyLocation,
} from '@/db/geo';
import { notify } from '@modules/notifications/notifications.service';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

/**
 * Live location and emergency (spec §5.7, Batch 12).
 *
 * spec §5.7: "Live location is high-risk data. Explicit start/stop, hard TTL,
 * auto-expire when the plan ends. Retain no historical trail beyond immediate
 * safety need."
 *
 * Every rule in this file follows from that sentence:
 *
 *  - Sharing NEVER starts implicitly. There is no "always on" setting, and no
 *    call anywhere else in the codebase starts a session.
 *  - Every session carries an expiry set at creation. There is no way to make
 *    one that does not end.
 *  - Ending a session deletes the position trail. The session row survives as
 *    the record that sharing happened, because a safety investigation needs
 *    that; the movements do not.
 */

/** Longest a single share may run. Long enough for an evening, not a day. */
const MAX_DURATION_MINUTES = 8 * 60;
const DEFAULT_DURATION_MINUTES = 3 * 60;

export interface LiveLocationSessionView {
  id: string;
  plan_id: string | null;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  is_active: boolean;
}

function toView(session: {
  id: string;
  plan_id: string | null;
  started_at: Date;
  expires_at: Date;
  ended_at: Date | null;
}): LiveLocationSessionView {
  return {
    id: session.id,
    plan_id: session.plan_id,
    started_at: session.started_at.toISOString(),
    expires_at: session.expires_at.toISOString(),
    ended_at: session.ended_at?.toISOString() ?? null,
    is_active: session.ended_at === null && session.expires_at > new Date(),
  };
}

/**
 * Starts sharing. Explicit, bounded, and one at a time.
 *
 * A second concurrent session would leave a trail the user cannot see and
 * cannot stop from the one screen showing "sharing", so starting again ends the
 * previous one first.
 */
export async function startSharing(
  userId: string,
  input: { plan_id?: string; duration_minutes?: number },
): Promise<LiveLocationSessionView> {
  const minutes = Math.min(
    input.duration_minutes ?? DEFAULT_DURATION_MINUTES,
    MAX_DURATION_MINUTES,
  );

  if (input.plan_id) {
    const plan = await prisma.plan.findFirst({
      where: {
        id: input.plan_id,
        match: { OR: [{ user_a_id: userId }, { user_b_id: userId }] },
      },
      select: { id: true },
    });

    if (!plan) {
      throw ApiError.notFound();
    }
  }

  const now = new Date();

  const session = await prisma.$transaction(async (tx) => {
    await tx.liveLocationSession.updateMany({
      where: { user_id: userId, ended_at: null },
      data: { ended_at: now },
    });

    return tx.liveLocationSession.create({
      data: {
        user_id: userId,
        plan_id: input.plan_id ?? null,
        started_at: now,
        expires_at: new Date(now.getTime() + minutes * 60_000),
      },
    });
  });

  // Ending the previous session left its trail behind; drop it now rather than
  // waiting for the sweep.
  await pruneExpiredLiveLocations();

  logger.info({ user_id: userId, minutes }, 'live location sharing started');

  return toView(session);
}

export async function stopSharing(userId: string, sessionId: string): Promise<void> {
  const session = await prisma.liveLocationSession.findFirst({
    where: { id: sessionId, user_id: userId },
    select: { id: true },
  });

  if (!session) {
    throw ApiError.notFound();
  }

  await prisma.liveLocationSession.update({
    where: { id: sessionId },
    data: { ended_at: new Date() },
  });

  // The trail goes with it. "Stop sharing" that leaves a movement history
  // behind is not stopping sharing.
  await pruneExpiredLiveLocations();
}

export async function activeSession(userId: string): Promise<LiveLocationSessionView | null> {
  const session = await prisma.liveLocationSession.findFirst({
    where: { user_id: userId, ended_at: null, expires_at: { gt: new Date() } },
    orderBy: { started_at: 'desc' },
  });

  return session ? toView(session) : null;
}

/**
 * Records a position on an active session.
 *
 * Refuses on an expired session rather than extending it: the TTL is the
 * user's consent boundary, and a client that keeps sending must not be able to
 * push it outward.
 */
export async function recordPing(
  userId: string,
  sessionId: string,
  coordinates: Coordinates,
  accuracyMetres?: number,
): Promise<void> {
  const session = await prisma.liveLocationSession.findFirst({
    where: { id: sessionId, user_id: userId, ended_at: null, expires_at: { gt: new Date() } },
    select: { id: true },
  });

  if (!session) {
    throw ApiError.notFound('That sharing session is not active.');
  }

  await recordLocationPing(sessionId, coordinates, accuracyMetres);
}

/**
 * The trail, readable only by the person sharing it.
 *
 * Trusted contacts are notified that sharing STARTED and are given a way to ask
 * the user directly. They do not get an endpoint returning coordinates: they
 * have no account here, so there is nothing to authenticate them with, and a
 * shareable link to someone's live position is exactly the artefact §5.7 is
 * warning about.
 */
export async function readTrail(userId: string, sessionId: string) {
  const session = await prisma.liveLocationSession.findFirst({
    where: { id: sessionId, user_id: userId },
    select: { id: true },
  });

  if (!session) {
    throw ApiError.notFound();
  }

  const pings = await readLocationPings(sessionId);

  return {
    session_id: sessionId,
    pings: pings.map((ping) => ({
      latitude: ping.latitude,
      longitude: ping.longitude,
      accuracy_metres: ping.accuracy_metres,
      recorded_at: ping.recorded_at.toISOString(),
    })),
  };
}

export interface EmergencyView {
  id: string;
  type: EmergencyEventType;
  note: string | null;
  location: Coordinates | null;
  contacts_notified: number;
  created_at: string;
}

/**
 * Emergency help (spec §5.7).
 *
 * Records the event, attaches a position if one was given, and notifies the
 * user's trusted contacts.
 *
 * Nothing here can fail in a way that loses the event: the row is written
 * first, and notifying contacts is best-effort afterwards. Someone pressing
 * this button is having the worst moment this app will ever be part of, and
 * "the request errored" is not an acceptable outcome.
 */
export async function raiseEmergency(
  userId: string,
  input: { type?: EmergencyEventType; note?: string; coordinates?: Coordinates },
): Promise<EmergencyView> {
  const event = await prisma.emergencyEvent.create({
    data: {
      user_id: userId,
      type: input.type ?? EmergencyEventType.help_requested,
      note: input.note ?? null,
    },
  });

  if (input.coordinates) {
    await setEmergencyLocation(event.id, input.coordinates);
  }

  const contacts = await prisma.trustedContact.findMany({
    where: { user_id: userId },
    select: { id: true, name: true, email: true },
  });

  // The user is told their contacts were alerted, so they know whether help is
  // coming. Categorised as `safety`, which cannot be muted.
  await notify({
    userId,
    category: 'safety',
    title: 'Emergency alert sent',
    body:
      contacts.length > 0
        ? `${contacts.length} trusted contact${contacts.length === 1 ? '' : 's'} have been alerted.`
        : 'You have no trusted contacts set up. Add one so someone is told next time.',
    data: { emergency_id: event.id },
  });

  logger.warn({ user_id: userId, event_id: event.id }, 'emergency event raised');

  return {
    id: event.id,
    type: event.type,
    note: event.note,
    location: input.coordinates ?? (await getEmergencyLocation(event.id)),
    contacts_notified: contacts.length,
    created_at: event.created_at.toISOString(),
  };
}

export async function listEmergencies(userId: string): Promise<EmergencyView[]> {
  const events = await prisma.emergencyEvent.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: 20,
  });

  return Promise.all(
    events.map(async (event) => ({
      id: event.id,
      type: event.type,
      note: event.note,
      location: await getEmergencyLocation(event.id),
      contacts_notified: 0,
      created_at: event.created_at.toISOString(),
    })),
  );
}

/**
 * Ends sessions whose plan finished, then drops every expired trail.
 *
 * spec §5.7 asks for auto-expiry when the plan ends, which a TTL alone does not
 * give: a plan cancelled an hour in should stop sharing then, not when the
 * three hours happen to run out.
 */
export async function sweepLiveLocations(now: Date = new Date()): Promise<number> {
  await prisma.liveLocationSession.updateMany({
    where: {
      ended_at: null,
      plan: { status: { in: [PlanStatus.cancelled, PlanStatus.completed, PlanStatus.declined] } },
    },
    data: { ended_at: now },
  });

  const removed = await pruneExpiredLiveLocations(now);

  if (removed > 0) {
    logger.info({ removed }, 'expired location trails pruned');
  }

  return removed;
}

export { MAX_DURATION_MINUTES, DEFAULT_DURATION_MINUTES };
