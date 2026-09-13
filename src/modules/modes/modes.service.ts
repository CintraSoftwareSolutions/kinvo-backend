import { Mode, type Prisma, prisma } from '@/db/prisma';
import { hasApprovedVerification } from '@modules/media/verification.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';
import { preferenceSchemaFor } from './mode-preferences.schema';
import type { ModeView, ModesResponse } from './modes.types';
import * as entitlementsService from '@modules/entitlements/entitlements.service';
import { ENTITLEMENT_KEYS } from '@modules/entitlements/entitlements.types';

/**
 * The eight modes (spec §1, §5.2).
 *
 * Preferences are stored PER MODE, not once per user. A 5km radius in Cuddle
 * and a 50km radius in Networking is normal and must be expressible — that is
 * the whole reason UserMode exists rather than columns on Profile.
 */

export const ALL_MODES: Mode[] = [
  Mode.dating,
  Mode.study_buddy,
  Mode.networking,
  Mode.trading,
  Mode.foodie,
  Mode.cuddle,
  Mode.pet_dates,
  Mode.fitness,
];

/**
 * spec §1: the mode changes only the label the app renders. The API accepts
 * pass | like | super_like everywhere, and these strings exist so adding a mode
 * never requires an app release.
 */
export const MODE_LABELS: Record<Mode, { label: string; primary_action: string }> = {
  [Mode.dating]: { label: 'Dating', primary_action: 'Like' },
  [Mode.study_buddy]: { label: 'Study Buddy', primary_action: 'Study' },
  [Mode.networking]: { label: 'Networking', primary_action: 'Connect' },
  [Mode.trading]: { label: 'Trading', primary_action: 'Trade' },
  [Mode.foodie]: { label: 'Foodie', primary_action: 'Taste' },
  [Mode.cuddle]: { label: 'Cuddle', primary_action: 'Cozy' },
  [Mode.pet_dates]: { label: 'Pet Dates', primary_action: 'Paw' },
  [Mode.fitness]: { label: 'Fitness', primary_action: 'Fitness' },
};

/**
 * spec §5.7 flags Cuddle as elevated risk: it invites physical-contact meetups
 * and will attract misuse. Requiring verification to enable it is the strongest
 * single lever available, and far easier to require from the start than to
 * impose later on people who already use it.
 *
 * Confirmed by the product owner, 2026-08-26.
 */
export const MODES_REQUIRING_VERIFICATION: Mode[] = [Mode.cuddle];

interface UserModeRow {
  mode: Mode;
  is_enabled: boolean;
  is_primary: boolean;
  min_age: number;
  max_age: number;
  radius_metres: number;
  verified_only: boolean;
  preferences: unknown;
  updated_at: Date;
}

function toView(mode: Mode, row: UserModeRow | undefined, isVerified: boolean): ModeView {
  const labels = MODE_LABELS[mode];
  const requiresVerification = MODES_REQUIRING_VERIFICATION.includes(mode);

  return {
    mode,
    label: labels.label,
    primary_action_label: labels.primary_action,
    is_enabled: row?.is_enabled ?? false,
    is_primary: row?.is_primary ?? false,
    requires_verification: requiresVerification,
    // So the app can grey the toggle out with a reason instead of letting the
    // user tap it and receive a 403 they did not expect.
    can_enable: !requiresVerification || isVerified,
    min_age: row?.min_age ?? 18,
    max_age: row?.max_age ?? 99,
    // spec §4.6: metres. The client formats to miles.
    radius_metres: row?.radius_metres ?? 48280,
    verified_only: row?.verified_only ?? false,
    preferences: (row?.preferences as Record<string, unknown>) ?? {},
    updated_at: row?.updated_at?.toISOString() ?? null,
  };
}

export async function listModes(userId: string): Promise<ModesResponse> {
  const rows = await prisma.userMode.findMany({ where: { user_id: userId } });
  const byMode = new Map(rows.map((row) => [row.mode, row as UserModeRow]));
  const isVerified = await hasApprovedVerification(userId);

  const modes = ALL_MODES.map((mode) => toView(mode, byMode.get(mode), isVerified));

  return {
    modes,
    enabled_count: modes.filter((m) => m.is_enabled).length,
    max_simultaneous_modes: await getMaxModes(userId),
    primary_mode: modes.find((m) => m.is_primary)?.mode ?? null,
  };
}

export async function getMode(userId: string, mode: Mode): Promise<ModeView> {
  const row = await prisma.userMode.findUnique({
    where: { user_id_mode: { user_id: userId, mode } },
  });

  return toView(
    mode,
    (row as UserModeRow | null) ?? undefined,
    await hasApprovedVerification(userId),
  );
}

/**
 * How many modes this user may run at once.
 *
 * Read from the seeded entitlement matrix rather than hardcoded, because
 * spec §5.11 requires the matrix to be data: changing the free-tier allowance
 * must be a seed change, never a code change. -1 means unlimited.
 */
export async function getMaxModes(userId: string): Promise<number> {
  // Batch 5 read the matrix directly because the resolver did not exist yet.
  // Batch 6 owns that read; two places interpreting the same rows would drift.
  return entitlementsService.getLimit(userId, ENTITLEMENT_KEYS.MAX_SIMULTANEOUS_MODES);
}

export interface UpdateModeInput {
  is_enabled?: boolean;
  min_age?: number;
  max_age?: number;
  radius_metres?: number;
  verified_only?: boolean;
  preferences?: Record<string, unknown>;
}

/**
 * Enables, disables, or reconfigures one mode.
 *
 * Upserts because a UserMode row only exists once the user has touched that
 * mode — eight rows per user created at signup would be eight rows per user
 * that mostly stay at their defaults.
 */
export async function updateMode(
  userId: string,
  mode: Mode,
  input: UpdateModeInput,
): Promise<ModeView> {
  if (input.min_age !== undefined && input.max_age !== undefined && input.min_age > input.max_age) {
    throw ApiError.validation({ min_age: ['The minimum age cannot be above the maximum.'] });
  }

  // Mode-specific extras are validated against that mode's own schema, so
  // `pet_type` on `dating` is rejected rather than silently stored.
  let preferences: Record<string, unknown> | undefined;
  if (input.preferences !== undefined) {
    const parsed = preferenceSchemaFor(mode).safeParse(input.preferences);

    if (!parsed.success) {
      const details: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.length > 0 ? `preferences.${issue.path.join('.')}` : 'preferences';
        (details[key] ??= []).push(issue.message);
      }
      throw ApiError.validation(details);
    }

    preferences = parsed.data as Record<string, unknown>;
  }

  if (input.is_enabled === true) {
    await assertCanEnable(userId, mode);
  }

  const existing = await prisma.userMode.findUnique({
    where: { user_id_mode: { user_id: userId, mode } },
    select: { id: true, is_primary: true, is_enabled: true },
  });

  // Disabling the primary mode would leave the account with no primary at all,
  // so the flag moves to another enabled mode first.
  const isDisablingPrimary = input.is_enabled === false && existing?.is_primary === true;

  const data = {
    ...(input.is_enabled !== undefined ? { is_enabled: input.is_enabled } : {}),
    ...(input.min_age !== undefined ? { min_age: input.min_age } : {}),
    ...(input.max_age !== undefined ? { max_age: input.max_age } : {}),
    ...(input.radius_metres !== undefined ? { radius_metres: input.radius_metres } : {}),
    ...(input.verified_only !== undefined ? { verified_only: input.verified_only } : {}),
    // Zod has already validated the shape against this mode's own schema; the
    // cast satisfies Prisma's JSON input type, which cannot express that.
    ...(preferences !== undefined ? { preferences: preferences as Prisma.InputJsonValue } : {}),
    ...(isDisablingPrimary ? { is_primary: false } : {}),
  };

  await prisma.userMode.upsert({
    where: { user_id_mode: { user_id: userId, mode } },
    create: { user_id: userId, mode, ...data },
    update: data,
  });

  // First enabled mode becomes primary; signup picks one (spec §5.2).
  if (input.is_enabled === true) {
    const hasPrimary = await prisma.userMode.findFirst({
      where: { user_id: userId, is_primary: true },
      select: { id: true },
    });

    if (!hasPrimary) {
      await prisma.userMode.update({
        where: { user_id_mode: { user_id: userId, mode } },
        data: { is_primary: true },
      });
    }
  }

  if (isDisablingPrimary) {
    await promoteAnotherPrimary(userId, mode);
  }

  return getMode(userId, mode);
}

/**
 * Enforces the entitlement cap and the Cuddle verification rule.
 *
 * Both return a code the app can act on: PREMIUM_REQUIRED carries paywall
 * context, FORBIDDEN carries the reason. Neither is a 404 — unlike a block,
 * there is nothing here to conceal.
 */
async function assertCanEnable(userId: string, mode: Mode): Promise<void> {
  if (MODES_REQUIRING_VERIFICATION.includes(mode) && !(await hasApprovedVerification(userId))) {
    throw new ApiError(ERROR_CODES.FORBIDDEN, 'Verify your identity to use this mode.', {
      reason: 'verification_required',
      mode,
    });
  }

  const alreadyEnabled = await prisma.userMode.findFirst({
    where: { user_id: userId, mode, is_enabled: true },
    select: { id: true },
  });

  // Re-saving preferences on an already-enabled mode is not a new enable.
  if (alreadyEnabled) {
    return;
  }

  const max = await getMaxModes(userId);
  if (max === -1) {
    return;
  }

  const enabledCount = await prisma.userMode.count({
    where: { user_id: userId, is_enabled: true },
  });

  if (enabledCount >= max) {
    // spec §4.9: a limit that sells subscriptions carries upgrade context.
    throw new ApiError(
      ERROR_CODES.PREMIUM_REQUIRED,
      `Your plan includes ${max} modes at a time. Upgrade for more.`,
      { limit: max, enabled: enabledCount, upgrade_available: true },
    );
  }
}

async function promoteAnotherPrimary(userId: string, excluding: Mode): Promise<void> {
  const next = await prisma.userMode.findFirst({
    where: { user_id: userId, is_enabled: true, mode: { not: excluding } },
    orderBy: { updated_at: 'desc' },
    select: { mode: true },
  });

  if (next) {
    await prisma.userMode.update({
      where: { user_id_mode: { user_id: userId, mode: next.mode } },
      data: { is_primary: true },
    });
  }
}

/** Exactly one primary mode per user — a partial unique index enforces it. */
export async function setPrimaryMode(userId: string, mode: Mode): Promise<ModesResponse> {
  const row = await prisma.userMode.findUnique({
    where: { user_id_mode: { user_id: userId, mode } },
    select: { is_enabled: true },
  });

  if (!row?.is_enabled) {
    throw ApiError.validation({ mode: ['Enable this mode before making it your primary.'] });
  }

  // Cleared before setting: the index permits only one primary per user, so
  // both must not be true even for an instant.
  await prisma.$transaction([
    prisma.userMode.updateMany({
      where: { user_id: userId, is_primary: true },
      data: { is_primary: false },
    }),
    prisma.userMode.update({
      where: { user_id_mode: { user_id: userId, mode } },
      data: { is_primary: true },
    }),
  ]);

  logger.info({ user_id: userId, mode }, 'primary mode changed');

  return listModes(userId);
}

/** Batch 7's deck builder needs this; Batch 5 exposes it for the checklist. */
export async function countEnabledModes(userId: string): Promise<number> {
  return prisma.userMode.count({ where: { user_id: userId, is_enabled: true } });
}
