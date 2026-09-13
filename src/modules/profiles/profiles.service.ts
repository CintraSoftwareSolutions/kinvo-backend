import { prisma } from '@/db/prisma';
import { distanceBetweenProfiles, getProfileCoordinates, setProfileLocation } from '@/db/geo';
import { assertVisible } from '@modules/safety/block.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { calculateAge } from '@utils/age';
import { toUserCompact } from '@utils/compact';
import { getPrimaryPhotoUrlFor } from '@modules/media/photos.service';
import { ensureProfile } from './profile.repository';
import { getProfileFacts, refreshCompletion, scoreCompletion } from './completion.service';
import type {
  OwnProfile,
  ProfileInterestItem,
  ProfilePromptItem,
  PublicProfile,
} from './profiles.types';

/**
 * Profile reading, writing, and scoring (spec §7, Batch 3).
 *
 * Two projections, deliberately kept as separate types: what you see about
 * yourself, and what everyone else sees. A shared interface would let a new
 * column leak to strangers just by being added.
 */

const FULL_PROFILE_INCLUDE = {
  interests: { include: { interest: true } },
  answers: { include: { question: true }, orderBy: { position: 'asc' } },
} as const;

// Scoring lives in completion.service so photos.service can recompute after an
// upload without importing this module, which would close an import cycle.
export { getProfileFacts, refreshCompletion, scoreCompletion };

// Defined in profile.repository so photos.service can use it without importing
// this module, which would close an import cycle. Re-exported so existing
// callers are unaffected.
export { ensureProfile };

type ProfileWithRelations = Awaited<ReturnType<typeof loadProfile>>;

async function loadProfile(userId: string) {
  const profile = await prisma.profile.findUnique({
    where: { user_id: userId },
    include: FULL_PROFILE_INCLUDE,
  });

  if (!profile) {
    throw ApiError.notFound('That profile does not exist.');
  }

  return profile;
}

function mapInterests(profile: ProfileWithRelations): ProfileInterestItem[] {
  return profile.interests.map((row) => ({
    id: row.interest.id,
    slug: row.interest.slug,
    label: row.interest.label,
    category: row.interest.category,
  }));
}

function mapPrompts(profile: ProfileWithRelations): ProfilePromptItem[] {
  return profile.answers.map((row) => ({
    question_id: row.question.id,
    slug: row.question.slug,
    question: row.question.question,
    answer: row.answer,
    position: row.position,
  }));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getOwnProfile(userId: string): Promise<OwnProfile> {
  await ensureProfile(userId);

  const profile = await loadProfile(userId);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      display_name: true,
      date_of_birth: true,
      is_verified: true,
      status: true,
      onboarded_at: true,
    },
  });

  const coordinates = await getProfileCoordinates(profile.id);

  return {
    id: profile.id,
    user_id: userId,
    display_name: user.display_name,
    date_of_birth: user.date_of_birth ? user.date_of_birth.toISOString().slice(0, 10) : null,
    age: user.date_of_birth ? calculateAge(user.date_of_birth) : null,
    bio: profile.bio,
    job_title: profile.job_title,
    organisation: profile.organisation,
    education: profile.education,
    height_cm: profile.height_cm,
    city: profile.city,
    country: profile.country,
    location: coordinates,
    location_updated_at: profile.location_updated_at?.toISOString() ?? null,
    drinking: profile.drinking,
    smoking: profile.smoking,
    exercise: profile.exercise,
    diet: profile.diet,
    pets: profile.pets,
    children: profile.children,
    interests: mapInterests(profile),
    prompts: mapPrompts(profile),
    completion_percentage: profile.completion_percentage,
    is_verified: user.is_verified,
    status: user.status,
    is_onboarded: user.onboarded_at !== null,
    created_at: profile.created_at.toISOString(),
    updated_at: profile.updated_at.toISOString(),
  };
}

/**
 * Another user's profile.
 *
 * `assertVisible` runs first and throws 404 for a block, a suspension, a soft
 * delete, or a user who never existed — all indistinguishable from outside
 * (spec §4.4, §5.5).
 */
export async function getPublicProfile(
  viewerId: string,
  targetUserId: string,
): Promise<PublicProfile> {
  await assertVisible(viewerId, targetUserId);

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      display_name: true,
      date_of_birth: true,
      is_verified: true,
      subscription_tier: true,
      last_active_at: true,
      profile: { include: FULL_PROFILE_INCLUDE },
    },
  });

  if (!target?.profile) {
    throw ApiError.notFound();
  }

  const viewerProfile = await prisma.profile.findUnique({
    where: { user_id: viewerId },
    select: { id: true },
  });

  const distance = viewerProfile
    ? await distanceBetweenProfiles(viewerProfile.id, target.profile.id)
    : null;

  return {
    // Approved photos only — spec §4.8 keeps pending media owner-visible.
    user: toUserCompact(target, await getPrimaryPhotoUrlFor(target.id)),
    bio: target.profile.bio,
    job_title: target.profile.job_title,
    organisation: target.profile.organisation,
    education: target.profile.education,
    height_cm: target.profile.height_cm,
    city: target.profile.city,
    // spec §4.6: metres, never a formatted string. The client renders miles.
    distance_metres: distance,
    drinking: target.profile.drinking,
    smoking: target.profile.smoking,
    exercise: target.profile.exercise,
    diet: target.profile.diet,
    pets: target.profile.pets,
    children: target.profile.children,
    interests: mapInterests(target.profile as ProfileWithRelations),
    prompts: mapPrompts(target.profile as ProfileWithRelations),
  };
}

/**
 * "How others see you" (spec §7, Batch 3) — the owner rendered through the
 * public projection, so what they preview is byte-for-byte what a stranger gets
 * rather than a lookalike that can drift.
 */
export async function getOwnPreview(userId: string): Promise<PublicProfile> {
  return getPublicProfile(userId, userId);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface UpdateProfileInput {
  bio?: string | null;
  job_title?: string | null;
  organisation?: string | null;
  education?: string | null;
  height_cm?: number | null;
  city?: string | null;
  country?: string | null;
  drinking?: string | null;
  smoking?: string | null;
  exercise?: string | null;
  diet?: string | null;
  pets?: string | null;
  children?: string | null;
  display_name?: string;
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<OwnProfile> {
  await ensureProfile(userId);

  const { display_name: displayName, ...profileFields } = input;

  if (displayName !== undefined) {
    await prisma.user.update({
      where: { id: userId },
      data: { display_name: displayName.trim() },
    });
  }

  if (Object.keys(profileFields).length > 0) {
    await prisma.profile.update({
      where: { user_id: userId },
      data: profileFields as never,
    });
  }

  await refreshCompletion(userId);
  return getOwnProfile(userId);
}

export async function updateLocation(
  userId: string,
  coordinates: { longitude: number; latitude: number },
  place?: { city?: string; country?: string },
): Promise<OwnProfile> {
  const profileId = await ensureProfile(userId);

  await setProfileLocation(profileId, coordinates);

  if (place?.city || place?.country) {
    await prisma.profile.update({
      where: { id: profileId },
      data: {
        ...(place.city ? { city: place.city } : {}),
        ...(place.country ? { country: place.country.toUpperCase() } : {}),
      },
    });
  }

  await refreshCompletion(userId);
  return getOwnProfile(userId);
}

/** Maximum interests per profile. Keeps the deck card renderable and the tag list meaningful. */
export const MAX_INTERESTS = 10;

/**
 * Replaces the interest set wholesale.
 *
 * PUT rather than POST/DELETE pairs: the client owns a chip selector, and a
 * replace is one round trip with no partial-failure state to reconcile.
 */
export async function setInterests(userId: string, slugs: string[]): Promise<OwnProfile> {
  const profileId = await ensureProfile(userId);
  const unique = [...new Set(slugs)];

  if (unique.length > MAX_INTERESTS) {
    throw ApiError.validation({
      interests: [`Choose at most ${MAX_INTERESTS} interests.`],
    });
  }

  const interests = await prisma.interest.findMany({
    where: { slug: { in: unique }, is_active: true },
    select: { id: true, slug: true },
  });

  const found = new Set(interests.map((interest) => interest.slug));
  const unknown = unique.filter((slug) => !found.has(slug));

  if (unknown.length > 0) {
    throw ApiError.validation({
      interests: [`Unknown interests: ${unknown.join(', ')}.`],
    });
  }

  await prisma.$transaction([
    prisma.profileInterest.deleteMany({ where: { profile_id: profileId } }),
    prisma.profileInterest.createMany({
      data: interests.map((interest) => ({ profile_id: profileId, interest_id: interest.id })),
    }),
  ]);

  await refreshCompletion(userId);
  return getOwnProfile(userId);
}

export const MAX_PROMPTS = 3;

export interface PromptAnswerInput {
  slug: string;
  answer: string;
}

export async function setPrompts(
  userId: string,
  answers: PromptAnswerInput[],
): Promise<OwnProfile> {
  const profileId = await ensureProfile(userId);

  if (answers.length > MAX_PROMPTS) {
    throw ApiError.validation({ prompts: [`Answer at most ${MAX_PROMPTS} prompts.`] });
  }

  const slugs = answers.map((answer) => answer.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw ApiError.validation({ prompts: ['Each prompt can only be answered once.'] });
  }

  const questions = await prisma.promptQuestion.findMany({
    where: { slug: { in: slugs }, is_active: true },
    select: { id: true, slug: true },
  });

  const bySlug = new Map(questions.map((question) => [question.slug, question.id]));
  const unknown = slugs.filter((slug) => !bySlug.has(slug));

  if (unknown.length > 0) {
    throw ApiError.validation({ prompts: [`Unknown prompts: ${unknown.join(', ')}.`] });
  }

  await prisma.$transaction([
    prisma.profileAnswer.deleteMany({ where: { profile_id: profileId } }),
    prisma.profileAnswer.createMany({
      data: answers.map((answer, index) => ({
        profile_id: profileId,
        question_id: bySlug.get(answer.slug)!,
        answer: answer.answer.trim(),
        position: index,
      })),
    }),
  ]);

  await refreshCompletion(userId);
  return getOwnProfile(userId);
}

export { ERROR_CODES };
