import { prisma } from '@/db/prisma';
import { disconnectDevice } from '@/realtime/emit';
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

/** What the app says about the device behind a request (spec §4.11). */
export interface DeviceDetails {
  userId: string;
  deviceId: string;
  platform: string;
  appVersion?: string;
  osVersion?: string;
  /** For example "Pixel 8", so the list can tell two phones apart. */
  model?: string;
}

function platformOf(value: string): string {
  return ['ios', 'android', 'web'].includes(value) ? value : 'web';
}

/** Records the device a sign-in comes from, or brings back one signed out before. */
export async function registerDevice(options: DeviceDetails): Promise<void> {
  await prisma.device.upsert({
    where: { user_id_device_id: { user_id: options.userId, device_id: options.deviceId } },
    create: {
      user_id: options.userId,
      device_id: options.deviceId,
      platform: platformOf(options.platform) as never,
      app_version: options.appVersion ?? null,
      os_version: options.osVersion ?? null,
      model: options.model ?? null,
    },
    update: {
      last_seen_at: new Date(),
      app_version: options.appVersion ?? null,
      os_version: options.osVersion ?? null,
      model: options.model ?? null,
      // A revoked device signing in again is a fresh, legitimate session.
      revoked_at: null,
    },
  });
}

/**
 * A session carrying on (a token refresh): keeps the device's last-seen time
 * and versions current.
 *
 * Never brings back a device that was signed out. A refresh that races a
 * sign-out from another phone must not undo it; only a new sign-in may.
 */
export async function touchDevice(options: DeviceDetails): Promise<void> {
  const touched = await prisma.device.updateMany({
    where: { user_id: options.userId, device_id: options.deviceId, revoked_at: null },
    data: {
      last_seen_at: new Date(),
      app_version: options.appVersion ?? null,
      os_version: options.osVersion ?? null,
      model: options.model ?? null,
    },
  });

  if (touched.count > 0) {
    return;
  }

  // A session that began before every sign-in recorded its device has no row
  // yet. A row that exists but was signed out is skipped, never revived.
  await prisma.device.createMany({
    data: [
      {
        user_id: options.userId,
        device_id: options.deviceId,
        platform: platformOf(options.platform) as never,
        app_version: options.appVersion ?? null,
        os_version: options.osVersion ?? null,
        model: options.model ?? null,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Whether the device behind a session was signed out: from the device list,
 * by "sign out everywhere else", or by logging out on it.
 *
 * Checked on every request and socket handshake, because an access token
 * would otherwise keep a signed-out phone working for up to 30 minutes. A
 * device that was never recorded counts as signed in: nothing could have
 * signed it out.
 */
export async function isDeviceSignedOut(userId: string, deviceId: string): Promise<boolean> {
  const device = await prisma.device.findUnique({
    where: { user_id_device_id: { user_id: userId, device_id: deviceId } },
    select: { revoked_at: true },
  });

  return Boolean(device?.revoked_at);
}

/**
 * Every device at once, for a password reset or change, which already revoke
 * every refresh token. Without this the device list kept showing them all as
 * signed in, and their access tokens kept working for up to 30 minutes.
 */
export async function signOutAllDevices(userId: string): Promise<void> {
  const devices = await prisma.device.findMany({
    where: { user_id: userId, revoked_at: null },
    select: { device_id: true },
  });

  await prisma.device.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date(), fcm_token: null },
  });

  for (const device of devices) {
    disconnectDevice(userId, device.device_id);
  }
}

/**
 * Logging out on a device: it leaves the device list and stops getting
 * notifications. The caller revokes its session tokens.
 */
export async function signOutDevice(userId: string, deviceId: string): Promise<void> {
  await prisma.device.updateMany({
    where: { user_id: userId, device_id: deviceId, revoked_at: null },
    data: { revoked_at: new Date(), fcm_token: null },
  });

  disconnectDevice(userId, deviceId);
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

  // Its live connection would otherwise keep delivering messages until the
  // app happened to reconnect.
  disconnectDevice(userId, device.device_id);

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

  for (const device of others) {
    disconnectDevice(userId, device.device_id);
  }

  logger.info({ user_id: userId, count: others.length }, 'other devices revoked');

  return others.length;
}
