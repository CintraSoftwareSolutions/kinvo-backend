import { type Coordinates, setProfileLocation } from '@/db/geo';
import { type Mode, type UserStatus, prisma } from '@/db/prisma';
import { issueTokenPair } from '@modules/auth/token.service';
import type { AuthTokens } from '@modules/auth/auth.types';
import { LONDON, adultDateOfBirth, uniqueEmail } from './factories';

/**
 * Discoverable users.
 *
 * A user only reaches a deck when several things are true at once: onboarded,
 * active, not snoozed, has a profile with a PostGIS location, and has THIS mode
 * enabled. Building that by hand in each test invites a case that passes
 * because the fixture was wrong rather than because the code is right.
 */

export interface DiscoverableOptions {
  mode: Mode;
  coordinates?: Coordinates;
  age?: number;
  is_verified?: boolean;
  is_snoozed?: boolean;
  status?: UserStatus;
  onboarded?: boolean;
  display_name?: string;
  radius_metres?: number;
  min_age?: number;
  max_age?: number;
  verified_only?: boolean;
  last_active_at?: Date;
  /** Enable a second mode on the same account, for mode-independence tests. */
  also_modes?: Mode[];
}

export async function createDiscoverableUser(options: DiscoverableOptions) {
  const onboarded = options.onboarded ?? true;

  const user = await prisma.user.create({
    data: {
      display_name: options.display_name ?? 'Deck User',
      date_of_birth: adultDateOfBirth(options.age ?? 28),
      status: options.status ?? 'active',
      is_verified: options.is_verified ?? false,
      is_snoozed: options.is_snoozed ?? false,
      onboarded_at: onboarded ? new Date() : null,
      last_active_at: options.last_active_at ?? new Date(),
      auth_identities: {
        create: { provider: 'email', identifier: uniqueEmail(), verified_at: new Date() },
      },
    },
  });

  const profile = await prisma.profile.create({
    data: { user_id: user.id, bio: 'Test profile', city: 'London', country: 'GB' },
  });

  await setProfileLocation(profile.id, options.coordinates ?? LONDON);

  for (const mode of [options.mode, ...(options.also_modes ?? [])]) {
    await prisma.userMode.create({
      data: {
        user_id: user.id,
        mode,
        is_enabled: true,
        is_primary: mode === options.mode,
        radius_metres: options.radius_metres ?? 48280,
        min_age: options.min_age ?? 18,
        max_age: options.max_age ?? 99,
        verified_only: options.verified_only ?? false,
      },
    });
  }

  return { user, profile };
}

/** A discoverable user who can also make requests. */
export async function createDiscoverableViewer(
  options: DiscoverableOptions,
): Promise<{ user_id: string; profile_id: string; tokens: AuthTokens }> {
  const { user, profile } = await createDiscoverableUser(options);
  const tokens = await issueTokenPair(user.id);

  return { user_id: user.id, profile_id: profile.id, tokens };
}
