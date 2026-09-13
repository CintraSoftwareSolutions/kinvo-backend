import { randomUUID } from 'node:crypto';

import { type Mode, type SwipeAction, UserStatus, prisma } from '@/db/prisma';
import { setProfileLocation, type Coordinates } from '@/db/geo';

/**
 * Factories for integration tests.
 *
 * Every factory generates its own unique identifiers so tests never collide and
 * can run in any order (spec §0.4). Nothing here is shared mutable state.
 *
 * Batch 1 has no service layer yet, so these talk to Prisma directly. Later
 * batches should keep using them for arranging state, not for exercising
 * behaviour — that is what the endpoints are for.
 */

export const LONDON: Coordinates = { longitude: -0.1276, latitude: 51.5072 }; // Westminster
export const CAMDEN: Coordinates = { longitude: -0.1426, latitude: 51.539 }; // ~3.7 km away
export const MANCHESTER: Coordinates = { longitude: -2.2426, latitude: 53.4808 }; // ~262 km away

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${randomUUID()}@kinvo.test`;
}

/** Someone comfortably over 18, so age checks are never the reason a test fails. */
export function adultDateOfBirth(age = 28): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - age, 5, 15));
}

export interface CreateUserOptions {
  display_name?: string;
  email?: string;
  date_of_birth?: Date;
  status?: UserStatus;
  is_verified?: boolean;
  is_snoozed?: boolean;
}

export async function createUser(options: CreateUserOptions = {}) {
  return prisma.user.create({
    data: {
      display_name: options.display_name ?? 'Test User',
      date_of_birth: options.date_of_birth ?? adultDateOfBirth(),
      status: options.status ?? UserStatus.active,
      is_verified: options.is_verified ?? false,
      is_snoozed: options.is_snoozed ?? false,
      onboarded_at: new Date(),
      auth_identities: {
        create: {
          provider: 'email',
          identifier: options.email ?? uniqueEmail(),
          verified_at: new Date(),
        },
      },
    },
  });
}

export interface CreateProfileOptions extends CreateUserOptions {
  coordinates?: Coordinates;
  city?: string;
  bio?: string;
}

/**
 * A user with a profile, and a PostGIS location if coordinates are given.
 * Returns both records — most tests need the user id and the profile id.
 */
export async function createUserWithProfile(options: CreateProfileOptions = {}) {
  const user = await createUser(options);

  const profile = await prisma.profile.create({
    data: {
      user_id: user.id,
      bio: options.bio ?? 'Test profile',
      city: options.city ?? 'London',
      country: 'GB',
    },
  });

  if (options.coordinates) {
    await setProfileLocation(profile.id, options.coordinates);
  }

  return { user, profile };
}

export async function createSwipe(
  actorId: string,
  targetId: string,
  mode: Mode,
  action: SwipeAction = 'like',
) {
  return prisma.swipe.create({
    data: { actor_id: actorId, target_id: targetId, mode, action },
  });
}

/**
 * Creates a match, ordering the pair to satisfy the CHECK constraint that keeps
 * (A,B) and (B,A) from both existing. Callers should not have to think about it.
 */
export async function createMatch(
  userIdA: string,
  userIdB: string,
  mode: Mode,
  options: { expiresInDays?: number } = {},
) {
  const [first, second] = [userIdA, userIdB].sort();

  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() + (options.expiresInDays ?? 7));

  return prisma.match.create({
    data: {
      user_a_id: first!,
      user_b_id: second!,
      mode,
      expires_at: expiresAt,
    },
  });
}

export async function createConversation(matchId: string, mode: Mode) {
  return prisma.conversation.create({ data: { match_id: matchId, mode } });
}

export async function createMessage(conversationId: string, senderId: string, body = 'Hello') {
  return prisma.message.create({
    data: { conversation_id: conversationId, sender_id: senderId, body },
  });
}

export async function createBlock(blockerId: string, blockedId: string) {
  return prisma.block.create({ data: { blocker_id: blockerId, blocked_id: blockedId } });
}

export async function createVenue(options: { coordinates?: Coordinates; category?: string } = {}) {
  const venue = await prisma.venue.create({
    data: {
      name: `Test Venue ${randomUUID().slice(0, 8)}`,
      category: (options.category as never) ?? 'cafe',
      city: 'London',
      country: 'GB',
    },
  });

  if (options.coordinates) {
    await prisma.$executeRaw`
      UPDATE venues
      SET location = ST_SetSRID(ST_MakePoint(${options.coordinates.longitude}::double precision, ${options.coordinates.latitude}::double precision), 4326)::geography
      WHERE id = ${venue.id}::uuid
    `;
  }

  return venue;
}
