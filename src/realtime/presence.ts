import { redis } from '@/db/redis';
import { prisma } from '@/db/prisma';
import { logger } from '@utils/logger';

const PRESENCE_PREFIX = 'presence:';

const PRESENCE_TTL_SECONDS = 90;

export const PRESENCE_HEARTBEAT_SECONDS = 45;

const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

const lastWrittenAt = new Map<string, number>();

function key(userId: string): string {
  return `${PRESENCE_PREFIX}${userId}`;
}

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

export function resetPresenceThrottle(): void {
  lastWrittenAt.clear();
}
