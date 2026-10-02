import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

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

  if (!device) {
    throw ApiError.notFound('That device is not signed in.');
  }

  if (device.revoked_at) {
    throw ApiError.notFound('That device is not signed in.');
  }
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

export async function unregisterPushToken(userId: string, deviceId: string): Promise<void> {
  await prisma.device.updateMany({
    where: { user_id: userId, device_id: deviceId },
    data: { fcm_token: null },
  });
}
