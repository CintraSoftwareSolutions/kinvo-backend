import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

/**
 * FCM token registration (spec §7, Batch 11).
 *
 * The token belongs to a DEVICE, not a user: one person may have a phone and a
 * tablet, each with its own token, and each must be able to lose or rotate its
 * token without affecting the other.
 */

export interface PushTokenView {
  device_id: string;
  registered: boolean;
}

export async function registerPushToken(
  userId: string,
  deviceId: string,
  token: string,
): Promise<PushTokenView> {
  const device = await prisma.device.findUnique({
    where: { user_id_device_id: { user_id: userId, device_id: deviceId } },
    select: { id: true, revoked_at: true },
  });

  // Devices are created at sign-in. A token for an unknown device means the
  // client got ahead of itself; 404 rather than creating a device row here,
  // because a device with no session is not something that should exist.
  if (!device) {
    throw ApiError.notFound('That device is not signed in.');
  }

  if (device.revoked_at) {
    throw ApiError.notFound('That device is not signed in.');
  }

  // FCM issues one token per app install. If this token was previously bound to
  // a different device row — a reinstall, or a restored backup — the old row
  // must give it up, or one push fans out to a device that no longer exists and
  // FCM starts reporting failures for a token that is actually alive.
  await prisma.device.updateMany({
    where: { fcm_token: token, NOT: { id: device.id } },
    data: { fcm_token: null },
  });

  await prisma.device.update({
    where: { id: device.id },
    data: { fcm_token: token, last_seen_at: new Date() },
  });

  logger.info({ user_id: userId, device_id: deviceId }, 'push token registered');

  return { device_id: deviceId, registered: true };
}

/**
 * Clears the token without ending the session.
 *
 * Distinct from revoking a device: this is "stop pushing to me", which is what
 * a user turning off notifications at the OS level should produce. Revoking a
 * device is a security action and signs it out.
 */
export async function unregisterPushToken(userId: string, deviceId: string): Promise<void> {
  await prisma.device.updateMany({
    where: { user_id: userId, device_id: deviceId },
    data: { fcm_token: null },
  });
}
