import { ModerationStatus, prisma } from '@/db/prisma';
import { getProfileCoordinates } from '@/db/geo';
import { ApiError } from '@utils/api-error';
import type { CompletionCriterion, ProfileCompletion } from './profiles.types';

/**
 * Profile completion scoring.
 *
 * Its own module so that anything changing a scored field can recompute the
 * total. Photos are scored, and photos.service cannot import profiles.service
 * (that service imports photos for the primary photo URL) — putting the scoring
 * here means both can call it without closing an import cycle.
 */

export interface CompletionInput {
  photo_count: number;
  bio: string | null;
  job_title: string | null;
  organisation: string | null;
  education: string | null;
  has_location: boolean;
  lifestyle_set_count: number;
  interest_count: number;
  prompt_count: number;
}

/**
 * A weighted checklist rather than scattered conditionals.
 *
 * The percentage is normalised over whatever criteria exist, so adding one —
 * as Batch 4 did with photos — re-weights the rest automatically instead of
 * capping the achievable total below 100.
 */
function buildCriteria(input: CompletionInput): CompletionCriterion[] {
  return [
    { key: 'photos', label: 'Add a photo', weight: 25, is_met: input.photo_count >= 1 },
    { key: 'bio', label: 'Write a bio', weight: 20, is_met: (input.bio?.length ?? 0) >= 20 },
    {
      key: 'interests',
      label: 'Add at least three interests',
      weight: 20,
      is_met: input.interest_count >= 3,
    },
    {
      key: 'prompts',
      label: 'Answer at least one prompt',
      weight: 20,
      is_met: input.prompt_count >= 1,
    },
    { key: 'location', label: 'Set your location', weight: 15, is_met: input.has_location },
    {
      key: 'work',
      label: 'Add your job or organisation',
      weight: 10,
      is_met: Boolean(input.job_title ?? input.organisation),
    },
    { key: 'education', label: 'Add your education', weight: 5, is_met: input.education !== null },
    {
      key: 'lifestyle',
      label: 'Fill in your lifestyle',
      weight: 10,
      is_met: input.lifestyle_set_count >= 3,
    },
  ];
}

export function scoreCompletion(input: CompletionInput): ProfileCompletion {
  const criteria = buildCriteria(input);

  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const earned = criteria.reduce(
    (sum, criterion) => sum + (criterion.is_met ? criterion.weight : 0),
    0,
  );

  return {
    percentage: total === 0 ? 0 : Math.round((earned / total) * 100),
    criteria,
  };
}

function countLifestyle(profile: {
  drinking: unknown;
  smoking: unknown;
  exercise: unknown;
  diet: unknown;
  pets: unknown;
  children: unknown;
}): number {
  return [
    profile.drinking,
    profile.smoking,
    profile.exercise,
    profile.diet,
    profile.pets,
    profile.children,
  ].filter((value) => value !== null && value !== undefined).length;
}

/**
 * Recomputes and persists the completion percentage.
 *
 * Stored rather than computed on read because Batch 7's deck ranking sorts on
 * it, and a per-row computation there would be a sequential scan.
 *
 * **Every write that changes a scored field must call this** — including adding
 * or removing a photo, which is exactly the case that was missed first time and
 * left the stored value stale.
 */
export async function refreshCompletion(userId: string): Promise<number> {
  const profile = await prisma.profile.findUnique({
    where: { user_id: userId },
    select: {
      id: true,
      bio: true,
      job_title: true,
      organisation: true,
      education: true,
      drinking: true,
      smoking: true,
      exercise: true,
      diet: true,
      pets: true,
      children: true,
      _count: { select: { interests: true, answers: true, photos: true } },
    },
  });

  if (!profile) {
    throw ApiError.notFound('That profile does not exist.');
  }

  const coordinates = await getProfileCoordinates(profile.id);

  const livePhotos = await prisma.photo.count({
    where: { profile_id: profile.id, deleted_at: null },
  });

  const { percentage } = scoreCompletion({
    photo_count: livePhotos,
    bio: profile.bio,
    job_title: profile.job_title,
    organisation: profile.organisation,
    education: profile.education,
    has_location: coordinates !== null,
    lifestyle_set_count: countLifestyle(profile),
    interest_count: profile._count.interests,
    prompt_count: profile._count.answers,
  });

  await prisma.profile.update({
    where: { id: profile.id },
    data: { completion_percentage: percentage },
  });

  return percentage;
}

/** The facts the onboarding checklist needs, without loading a whole profile. */
export async function getProfileFacts(userId: string): Promise<{
  has_profile: boolean;
  has_bio: boolean;
  has_location: boolean;
  interest_count: number;
  prompt_count: number;
  approved_photo_count: number;
}> {
  const profile = await prisma.profile.findUnique({
    where: { user_id: userId },
    select: {
      id: true,
      bio: true,
      _count: { select: { interests: true, answers: true } },
    },
  });

  if (!profile) {
    return {
      has_profile: false,
      has_bio: false,
      has_location: false,
      interest_count: 0,
      prompt_count: 0,
      approved_photo_count: 0,
    };
  }

  const coordinates = await getProfileCoordinates(profile.id);

  const approvedPhotos = await prisma.photo.count({
    where: {
      profile_id: profile.id,
      deleted_at: null,
      moderation_status: ModerationStatus.approved,
    },
  });

  return {
    has_profile: true,
    has_bio: (profile.bio?.trim().length ?? 0) > 0,
    has_location: coordinates !== null,
    interest_count: profile._count.interests,
    prompt_count: profile._count.answers,
    approved_photo_count: approvedPhotos,
  };
}
