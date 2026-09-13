import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

/**
 * Connected devices (spec §7, Batch 5).
 *
 * Revoking a device is a security action, so it must actually end the session
 * rather than only removing a row from a list. Each revoke kills the refresh
 * token family bound to that device — otherwise a stolen phone keeps working
 * and the settings screen tells the user a comforting lie.
 */

export interface DeviceView {
  id: string;
  device_id: string;
  platform: string;
  app_version: string | null;
  os_version: string | null;
  model: string | null;
  is_current: boolean;
  last_seen_at: string;
  created_at: string;
}

export async function listDevices(userId: string, currentDeviceId?: string): Promise<DeviceView[]> {
  const devices = await prisma.device.findMany({
    where: { user_id: userId, revoked_at: null },
    orderBy: { last_seen_at: 'desc' },
  });

  return devices.map((device) => ({
    id: device.id,
    device_id: device.device_id,
    platform: device.platform,
    app_version: device.app_version,
    os_version: device.os_version,
    model: device.model,
    // So the app can label one entry "This device" and refuse to let the user
    // sign themselves out by accident.
    is_current: currentDeviceId !== undefined && device.device_id === currentDeviceId,
    last_seen_at: device.last_seen_at.toISOString(),
    created_at: device.created_at.toISOString(),
  }));
}

/**
 * Records or refreshes the device behind a request, from the headers the app
 * always sends (spec §4.11). Called on sign-in.
 */
export async function registerDevice(options: {
  userId: string;
  deviceId: string;
  platform: string;
  appVersion?: string;
  osVersion?: string;
  model?: string;
}): Promise<void> {
  const platform = ['ios', 'android', 'web'].includes(options.platform) ? options.platform : 'web';

  await prisma.device.upsert({
    where: { user_id_device_id: { user_id: options.userId, device_id: options.deviceId } },
    create: {
      user_id: options.userId,
      device_id: options.deviceId,
      platform: platform as never,
      app_version: options.appVersion ?? null,
      os_version: options.osVersion ?? null,
      model: options.model ?? null,
    },
    update: {
      last_seen_at: new Date(),
      app_version: options.appVersion ?? null,
      os_version: options.osVersion ?? null,
      // A revoked device signing in again is a fresh, legitimate session.
      revoked_at: null,
    },
  });
}

/**
 * Revokes one device and ends its session.
 *
 * The token family is matched on device_id, which is what makes this a real
 * sign-out rather than a cosmetic list change.
 */
export async function revokeDevice(userId: string, deviceRowId: string): Promise<void> {
  const device = await prisma.device.findFirst({
    where: { id: deviceRowId, user_id: userId, revoked_at: null },
    select: { id: true, device_id: true },
  });

  // Scoped to the caller: another user's device id is a 404, never a 403 that
  // would confirm it exists.
  if (!device) {
    throw ApiError.notFound('That device is not signed in.');
  }

  await prisma.$transaction([
    prisma.device.update({
      where: { id: device.id },
      data: { revoked_at: new Date(), fcm_token: null },
    }),
    prisma.refreshToken.updateMany({
      where: { user_id: userId, device_id: device.device_id, revoked_at: null },
      data: { revoked_at: new Date() },
    }),
  ]);

  logger.info({ user_id: userId, device_id: device.device_id }, 'device revoked');
}

/**
 * "Sign out everywhere else" — the button a user reaches for after losing a
 * phone. Keeps the current device so they are not locked out of the screen
 * they just used.
 */
export async function revokeOtherDevices(
  userId: string,
  currentDeviceId?: string,
): Promise<number> {
  const others = await prisma.device.findMany({
    where: {
      user_id: userId,
      revoked_at: null,
      ...(currentDeviceId ? { device_id: { not: currentDeviceId } } : {}),
    },
    select: { id: true, device_id: true },
  });

  if (others.length === 0) {
    return 0;
  }

  await prisma.$transaction([
    prisma.device.updateMany({
      where: { id: { in: others.map((d) => d.id) } },
      data: { revoked_at: new Date(), fcm_token: null },
    }),
    prisma.refreshToken.updateMany({
      where: {
        user_id: userId,
        revoked_at: null,
        ...(currentDeviceId ? { device_id: { not: currentDeviceId } } : {}),
      },
      data: { revoked_at: new Date() },
    }),
  ]);

  logger.info({ user_id: userId, count: others.length }, 'other devices revoked');

  return others.length;
}
