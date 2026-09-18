import { calculateAge } from '@utils/age';

/**
 * Shared compact shapes (spec §4.7).
 *
 * "Return enough to render a screen in one request. A match list item that
 * returns only user_id forces N+1 calls and a janky list."
 *
 * These become single Dart models on the client, so the shape must be identical
 * everywhere it appears — decks, matches, likes-you, conversation headers. Build
 * it here and nowhere else.
 */

export interface UserCompact {
  id: string;
  display_name: string;
  age: number | null;
  primary_photo_url: string | null;
  is_verified: boolean;
  is_premium: boolean;
  is_online: boolean;
  /** Null when they have chosen not to show when they were last active. */
  last_active_at: string | null;
}

/** The columns any query must select to build a UserCompact. */
export interface UserCompactSource {
  id: string;
  display_name: string;
  date_of_birth: Date | null;
  is_verified: boolean;
  subscription_tier: string;
  last_active_at: Date;
  /**
   * Their settings row. Rows are created on first use, so null means the
   * defaults.
   */
  settings: { show_last_active: boolean } | null;
}

/**
 * @param primaryPhotoUrl passed in rather than read from a nested relation, so
 * every caller decides explicitly how it loads the photo.
 * @param isOnline passed in for the same reason, and resolved in BULK by the
 * caller via `onlineStatusFor`. Reading presence per row here would be the N+1
 * this shape exists to prevent (spec §4.7). Defaults to false: a list that has
 * not resolved presence understates activity rather than claiming someone is
 * available when nobody knows.
 */
export function toUserCompact(
  source: UserCompactSource,
  primaryPhotoUrl: string | null = null,
  isOnline = false,
): UserCompact {
  // Settings → "Show when I'm active". Someone who turns it off is neither
  // online nor recently active to anyone else, on every screen at once,
  // because every screen builds people here. The default is to show it.
  const showsActivity = source.settings?.show_last_active ?? true;

  return {
    id: source.id,
    display_name: source.display_name,
    // spec §5.1: age is always computed from date of birth, never stored.
    age: source.date_of_birth ? calculateAge(source.date_of_birth) : null,
    primary_photo_url: primaryPhotoUrl,
    is_verified: source.is_verified,
    is_premium: source.subscription_tier !== 'free',
    is_online: showsActivity && isOnline,
    // spec §4.6: UTC ISO-8601 with Z.
    last_active_at: showsActivity ? source.last_active_at.toISOString() : null,
  };
}

/**
 * The Prisma `select` that produces a UserCompactSource. Kept beside the mapper
 * so a field added to one is impossible to forget in the other.
 */
export const USER_COMPACT_SELECT = {
  id: true,
  display_name: true,
  date_of_birth: true,
  is_verified: true,
  subscription_tier: true,
  last_active_at: true,
  settings: { select: { show_last_active: true } },
} as const;
