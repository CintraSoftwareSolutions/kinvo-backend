import { prisma } from '@/db/prisma';
import { broadcastActivityVisibility } from '@/realtime/emit';
import { discardTodaysDecks } from '@modules/discovery/deck.service';
import { matchLikesHeldByPause } from '@modules/discovery/swipe.service';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

export interface SettingsView {
  theme: string;
  text_scale: number;
  reduce_motion: boolean;
  high_contrast: boolean;
  distance_unit: string;
  show_distance: boolean;
  show_last_active: boolean;
  incognito: boolean;
  global_verified_only: boolean;
  pause_new_matches: boolean;
  language: string;
  snooze: {
    is_snoozed: boolean;
    ends_at: string | null;
  };
  updated_at: string;
}

interface SettingsRow {
  theme: string;
  text_scale: number;
  reduce_motion: boolean;
  high_contrast: boolean;
  distance_unit: string;
  show_distance: boolean;
  show_last_active: boolean;
  incognito: boolean;
  global_verified_only: boolean;
  pause_new_matches: boolean;
  language: string;
  updated_at: Date;
}

function toView(
  row: SettingsRow,
  snooze: { is_snoozed: boolean; snooze_ends_at: Date | null },
): SettingsView {
  return {
    theme: row.theme,
    text_scale: row.text_scale,
    reduce_motion: row.reduce_motion,
    high_contrast: row.high_contrast,
    distance_unit: row.distance_unit,
    show_distance: row.show_distance,
    show_last_active: row.show_last_active,
    incognito: row.incognito,
    global_verified_only: row.global_verified_only,
    pause_new_matches: row.pause_new_matches,
    language: row.language,
    snooze: {
      is_snoozed: snooze.is_snoozed,
      ends_at: snooze.snooze_ends_at?.toISOString() ?? null,
    },
    updated_at: row.updated_at.toISOString(),
  };
}

export async function getSettings(userId: string): Promise<SettingsView> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { is_snoozed: true, snooze_ends_at: true },
  });

  if (!user) {
    throw ApiError.notFound();
  }

  const settings = await prisma.userSettings.upsert({
    where: { user_id: userId },
    create: { user_id: userId },
    update: {},
  });

  return toView(settings as SettingsRow, user);
}

export interface UpdateSettingsInput {
  theme?: string;
  text_scale?: number;
  reduce_motion?: boolean;
  high_contrast?: boolean;
  distance_unit?: string;
  show_distance?: boolean;
  show_last_active?: boolean;
  incognito?: boolean;
  global_verified_only?: boolean;
  pause_new_matches?: boolean;
  language?: string;
}

export async function updateSettings(
  userId: string,
  input: UpdateSettingsInput,
): Promise<SettingsView> {
  const before = await getSettings(userId);

  await prisma.userSettings.update({
    where: { user_id: userId },
    data: input as never,
  });

  if (input.show_last_active !== undefined && input.show_last_active !== before.show_last_active) {
    await broadcastActivityVisibility(userId, input.show_last_active);
  }

  if (
    input.global_verified_only !== undefined &&
    input.global_verified_only !== before.global_verified_only
  ) {
    await discardTodaysDecks(userId);
  }

  // Likes that became mutual while new matches were paused turn into the
  // matches they would have been.
  if (input.pause_new_matches === false && before.pause_new_matches) {
    await matchLikesHeldByPause(userId);
  }

  return getSettings(userId);
}

export async function snooze(userId: string, endsAt: Date | null): Promise<SettingsView> {
  if (endsAt && endsAt.getTime() <= Date.now()) {
    throw ApiError.validation({ ends_at: ['Choose a time in the future.'] });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { is_snoozed: true, snooze_ends_at: endsAt },
  });

  logger.info({ user_id: userId, ends_at: endsAt?.toISOString() ?? null }, 'account snoozed');

  return getSettings(userId);
}

export async function unsnooze(userId: string): Promise<SettingsView> {
  await prisma.user.update({
    where: { id: userId },
    data: { is_snoozed: false, snooze_ends_at: null },
  });

  logger.info({ user_id: userId }, 'account unsnoozed');

  return getSettings(userId);
}

export async function expireSnoozes(now: Date = new Date()): Promise<number> {
  const result = await prisma.user.updateMany({
    where: { is_snoozed: true, snooze_ends_at: { not: null, lte: now } },
    data: { is_snoozed: false, snooze_ends_at: null },
  });

  return result.count;
}
