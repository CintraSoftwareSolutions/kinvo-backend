import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

/**
 * Settings (spec §7, Batch 5).
 *
 * Theme and accessibility are stored server-side deliberately, so they follow
 * the user to a new device rather than resetting on reinstall.
 *
 * Kept apart from Profile because none of it is ever shown to another user. A
 * setting cannot leak into a deck card by being added to the wrong model.
 */

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
    // spec §5.6: snooze lives on the user, not here — the deck exclusion clause
    // reads one boolean on every discovery query and must not join a settings
    // table to do it. Surfaced here because it belongs on the settings screen.
    snooze: {
      is_snoozed: snooze.is_snoozed,
      ends_at: snooze.snooze_ends_at?.toISOString() ?? null,
    },
    updated_at: row.updated_at.toISOString(),
  };
}

/** Creates the row on first read rather than at signup, where it would mostly sit at defaults. */
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
  await getSettings(userId);

  await prisma.userSettings.update({
    where: { user_id: userId },
    data: input as never,
  });

  return getSettings(userId);
}

/**
 * Snooze (spec §5.6): hides the profile from all decks. Does not delete. The
 * account stays active and existing matches and conversations survive — which
 * is exactly why it is a flag rather than a status.
 *
 * `ends_at` is optional. Without it the snooze lasts until manually lifted;
 * with it, a scheduled job clears the flag when the time passes. Either way the
 * deck exclusion clause reads a single boolean.
 */
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

/**
 * Clears snoozes whose timer has passed. Called by the scheduler from Batch 7;
 * exported now so the behaviour is testable before the job exists.
 */
export async function expireSnoozes(now: Date = new Date()): Promise<number> {
  const result = await prisma.user.updateMany({
    where: { is_snoozed: true, snooze_ends_at: { not: null, lte: now } },
    data: { is_snoozed: false, snooze_ends_at: null },
  });

  return result.count;
}
