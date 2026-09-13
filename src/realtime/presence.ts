import { redis } from '@/db/redis';
import { prisma } from '@/db/prisma';
import { logger } from '@utils/logger';

/**
 * Presence (spec §7, Batch 9).
 *
 * Online state lives in Redis, not Postgres. It changes on every connect and
 * disconnect — writing that to a durable store would produce more writes than
 * the rest of the product combined, for a fact that is worthless the moment the
 * process restarts.
 *
 * `last_active_at` is the opposite: it belongs in Postgres because it is shown
 * on profiles long after the socket is gone. It is written on a throttle rather
 * than on every event.
 */

const PRESENCE_PREFIX = 'presence:';

/**
 * A presence key outlives its socket by this much.
 *
 * A user switching networks or locking their phone drops the socket and
 * reconnects seconds later. Without the grace period every commuter flickers
 * offline and online, and every one of those flickers is an event fanned out to
 * their matches.
 */
const PRESENCE_TTL_SECONDS = 90;

/** How often a live connection refreshes the key and last_active_at. */
export const PRESENCE_HEARTBEAT_SECONDS = 45;

/** Postgres write throttle — a ping every 45s must not be a row update every 45s. */
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

const lastWrittenAt = new Map<string, number>();

function key(userId: string): string {
  return `${PRESENCE_PREFIX}${userId}`;
}

/**
 * Counts CONNECTIONS, not users.
 *
 * One person may have a phone and a tablet open. Tracking a boolean would let
 * closing one device mark them offline while the other is still connected.
 */
export async function markOnline(userId: string, socketId: string): Promise<void> {
  try {
    await redis.sadd(key(userId), socketId);
    await redis.expire(key(userId), PRESENCE_TTL_SECONDS);
  } catch (error) {
    // Presence is a nicety. A Redis outage must not stop a socket connecting.
    logger.error({ err: error, user_id: userId }, 'presence write failed');
  }
}

export async function markOffline(userId: string, socketId: string): Promise<boolean> {
  try {
    await redis.srem(key(userId), socketId);
    const remaining = await redis.scard(key(userId));

    if (remaining === 0) {
      await redis.del(key(userId));
      return true;
    }

    return false;
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'presence clear failed');
    return false;
  }
}

export async function refresh(userId: string): Promise<void> {
  try {
    await redis.expire(key(userId), PRESENCE_TTL_SECONDS);
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'presence refresh failed');
  }
}

export async function isOnline(userId: string): Promise<boolean> {
  try {
    return (await redis.scard(key(userId))) > 0;
  } catch {
    // Reporting offline is the safe default: it understates activity rather
    // than claiming someone is available when nobody knows.
    return false;
  }
}

/**
 * Online state for many users in one round trip.
 *
 * Every list that returns `user_compact` needs this, and doing it per row would
 * be the same N+1 that compact objects exist to prevent (spec §4.7).
 */
export async function onlineStatusFor(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) {
    return new Set();
  }

  try {
    const pipeline = redis.pipeline();
    for (const userId of userIds) {
      pipeline.scard(key(userId));
    }

    const results = await pipeline.exec();
    const online = new Set<string>();

    results?.forEach(([error, count], index) => {
      const userId = userIds[index];
      if (!error && typeof count === 'number' && count > 0 && userId) {
        online.add(userId);
      }
    });

    return online;
  } catch (error) {
    logger.error({ err: error }, 'bulk presence read failed');
    return new Set();
  }
}

/**
 * Updates `last_active_at`, at most once per throttle window per user.
 *
 * The in-process map means each instance throttles independently, so a user on
 * several instances writes a few times rather than once. That is fine — the
 * point is bounding writes, not making them exactly once.
 */
export async function touchLastActive(userId: string, now = Date.now()): Promise<void> {
  const previous = lastWrittenAt.get(userId) ?? 0;

  if (now - previous < LAST_ACTIVE_THROTTLE_MS) {
    return;
  }

  lastWrittenAt.set(userId, now);

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { last_active_at: new Date(now) },
    });
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'last_active_at update failed');
  }
}

/** Test helper: the throttle map is process state and outlives a truncate. */
export function resetPresenceThrottle(): void {
  lastWrittenAt.clear();
}
