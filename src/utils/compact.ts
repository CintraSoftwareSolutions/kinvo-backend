import { calculateAge } from '@utils/age';

export interface UserCompact {
  id: string;
  display_name: string;
  age: number | null;
  primary_photo_url: string | null;
  is_verified: boolean;
  is_premium: boolean;
  is_online: boolean;
  last_active_at: string | null;
}

export interface UserCompactSource {
  id: string;
  display_name: string;
  date_of_birth: Date | null;
  is_verified: boolean;
  subscription_tier: string;
  last_active_at: Date;
  settings: { show_last_active: boolean } | null;
}

export function toUserCompact(
  source: UserCompactSource,
  primaryPhotoUrl: string | null = null,
  isOnline = false,
): UserCompact {
  const showsActivity = source.settings?.show_last_active ?? true;

  return {
    id: source.id,
    display_name: source.display_name,
    age: source.date_of_birth ? calculateAge(source.date_of_birth) : null,
    primary_photo_url: primaryPhotoUrl,
    is_verified: source.is_verified,
    is_premium: source.subscription_tier !== 'free',
    is_online: showsActivity && isOnline,
    last_active_at: showsActivity ? source.last_active_at.toISOString() : null,
  };
}

export const USER_COMPACT_SELECT = {
  id: true,
  display_name: true,
  date_of_birth: true,
  is_verified: true,
  subscription_tier: true,
  last_active_at: true,
  settings: { select: { show_last_active: true } },
} as const;
