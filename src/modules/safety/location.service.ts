import { EmergencyEventType, PlanStatus, prisma } from '@/db/prisma';
import {
  type Coordinates,
  getEmergencyLocation,
  pruneExpiredLiveLocations,
  readLocationPings,
  recordLocationPing,
  setEmergencyLocation,
} from '@/db/geo';
import { env } from '@config/env';
import { notify } from '@modules/notifications/notifications.service';
import { getEmailProvider } from '@modules/notifications/providers';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';
import { type ContactAlert, countEmailed, emailContacts, emergencySummary } from './contact-alerts';
import { type PlanForContact, emergencyAlertEmail, safetyTeamEmail } from './safety.emails';

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
  /**
   * How many trusted contacts were emailed. Only known as it is raised, so
   * `null` in the history rather than a number that would be a guess.
   */
  contacts_notified: number | null;
  /** Each trusted contact and what happened to them. Empty in the history. */
  contacts: ContactAlert[];
  /** What the user is told happened, as they should see it. */
  summary: string | null;
  created_at: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Past this many alerts in an hour, contacts aren't emailed again. They already
 * have this hour's alerts, and without a cap the button could flood the inbox
 * of anyone the user typed in as a contact.
 */
const EMERGENCY_ALERTS_PER_HOUR = 5;

/**
 * Emergency help (spec §5.7).
 *
 * Records the event, attaches a position if one was given, emails the user's
 * trusted contacts, copies the safety team, and tells the user exactly who
 * was reached. A contact without an email address, or an email that didn't
 * send, is reported as not reached — never as told.
 *
 * Nothing here can fail in a way that loses the event: the row is written
 * first, and alerting is best-effort afterwards. Someone pressing this button
 * is having the worst moment this app will ever be part of, and "the request
 * errored" is not an acceptable outcome.
 */
export async function raiseEmergency(
  userId: string,
  input: {
    type?: EmergencyEventType;
    note?: string;
    coordinates?: Coordinates;
    /** The phone's offset from UTC, so times read as the user's own. */
    utcOffsetMinutes?: number;
  },
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

  const [user, contacts, raisedThisHour, plan] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { display_name: true } }),
    prisma.trustedContact.findMany({
      where: { user_id: userId },
      select: { id: true, name: true, email: true },
      orderBy: { created_at: 'asc' },
    }),
    prisma.emergencyEvent.count({
      where: { user_id: userId, created_at: { gte: new Date(Date.now() - HOUR_MS) } },
    }),
    currentPlanFor(userId, event.created_at),
  ]);

  const coordinates = input.coordinates ?? null;
  const withinCap = raisedThisHour <= EMERGENCY_ALERTS_PER_HOUR;
  const alerts = withinCap
    ? await emailContacts(contacts, (contact) =>
        emergencyAlertEmail({
          to: contact.email,
          contactName: contact.name,
          senderName: user?.display_name ?? 'Someone you know',
          at: event.created_at,
          utcOffsetMinutes: input.utcOffsetMinutes,
          coordinates,
          note: event.note,
          plan,
        }),
      )
    : [];

  if (withinCap && env.SAFETY_ALERT_EMAIL) {
    // Best effort, like every email: the event is already recorded.
    await getEmailProvider().send(
      safetyTeamEmail({
        to: env.SAFETY_ALERT_EMAIL,
        eventId: event.id,
        userId,
        at: event.created_at,
        coordinates,
        note: event.note,
        contactsEmailed: countEmailed(alerts),
        contactsTotal: contacts.length,
      }),
    );
  }

  const summary = withinCap
    ? emergencySummary(alerts)
    : 'Your trusted contacts were already alerted in the last hour. Call them, or your local emergency number.';

  // Categorised as `safety`, which cannot be muted: the user needs to know
  // whether anyone was reached.
  await notify({
    userId,
    category: 'safety',
    title: countEmailed(alerts) > 0 ? 'Emergency alert sent' : 'Nobody was emailed',
    body: summary,
    data: { emergency_id: event.id },
  });

  logger.warn(
    { user_id: userId, event_id: event.id, contacts_emailed: countEmailed(alerts) },
    'emergency event raised',
  );

  return {
    id: event.id,
    type: event.type,
    note: event.note,
    location: coordinates ?? (await getEmergencyLocation(event.id)),
    contacts_notified: countEmailed(alerts),
    contacts: alerts,
    summary,
    created_at: event.created_at.toISOString(),
  };
}

/**
 * The plan the user is most likely on right now: a confirmed plan that
 * started in the last six hours or starts in the next two. Who they are with
 * and where is what anyone trying to help needs first.
 */
async function currentPlanFor(userId: string, at: Date): Promise<PlanForContact | null> {
  const plan = await prisma.plan.findFirst({
    where: {
      status: PlanStatus.confirmed,
      scheduled_at: {
        gte: new Date(at.getTime() - 6 * HOUR_MS),
        lte: new Date(at.getTime() + 2 * HOUR_MS),
      },
      match: { OR: [{ user_a_id: userId }, { user_b_id: userId }] },
    },
    orderBy: { scheduled_at: 'desc' },
    select: {
      scheduled_at: true,
      duration_minutes: true,
      custom_location: true,
      custom_address: true,
      venue: { select: { name: true, address: true } },
      match: {
        select: {
          user_a_id: true,
          user_a: { select: { display_name: true } },
          user_b: { select: { display_name: true } },
        },
      },
    },
  });

  if (!plan) {
    return null;
  }

  const other = plan.match.user_a_id === userId ? plan.match.user_b : plan.match.user_a;

  return {
    withName: other.display_name,
    place: plan.venue?.name ?? plan.custom_location ?? 'a place they did not name',
    address: plan.venue?.address ?? plan.custom_address,
    at: plan.scheduled_at,
    durationMinutes: plan.duration_minutes,
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
      contacts_notified: null,
      contacts: [],
      summary: null,
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
