import { UserStatus, prisma } from '@/db/prisma';
import { getProfileFacts } from '@modules/profiles/completion.service';
import { countEnabledModes } from '@modules/modes/modes.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { assertAdult } from '@utils/age';
import { logger } from '@utils/logger';

/**
 * Onboarding (spec §5.1): a state machine, `pending -> active`, that only
 * advances when the required fields are present.
 *
 * This is the gate that makes the under-18 rule work for social and phone
 * signups. Those accounts are created with no date of birth, so they cannot
 * complete onboarding, so `requireOnboarded` keeps them out of discovery,
 * matching, and chat until a date of birth exists and passes the check.
 *
 * The requirements are a declared checklist rather than scattered conditionals,
 * because later batches add to them: Batch 4 adds "at least one approved photo"
 * and Batch 5 adds "at least one enabled mode". Adding a requirement should be
 * one entry here, not a rewrite of the transition.
 */

export interface OnboardingStep {
  key: string;
  label: string;
  is_complete: boolean;
}

export interface OnboardingStatus {
  is_complete: boolean;
  can_complete: boolean;
  status: string;
  completed_at: string | null;
  steps: OnboardingStep[];
  missing: string[];
}

export async function getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      display_name: true,
      date_of_birth: true,
      status: true,
      onboarded_at: true,
    },
  });

  if (!user) {
    throw ApiError.notFound();
  }

  const facts = await getProfileFacts(userId);
  const enabledModes = await countEnabledModes(userId);

  const steps: OnboardingStep[] = [
    {
      key: 'display_name',
      label: 'Tell us your name',
      is_complete: user.display_name.trim().length > 0,
    },
    {
      key: 'date_of_birth',
      // Required for the legal age check. Social and phone signups arrive
      // without one, which is the whole reason this gate exists.
      label: 'Confirm your date of birth',
      is_complete: user.date_of_birth !== null,
    },
    { key: 'bio', label: 'Write a short bio', is_complete: facts.has_bio },
    { key: 'location', label: 'Share your location', is_complete: facts.has_location },
    {
      key: 'interests',
      label: 'Pick at least one interest',
      is_complete: facts.interest_count >= 1,
    },
    {
      key: 'photo',
      label: 'Add a photo',
      // Added in Batch 4, as planned. A deck full of blank cards is not a
      // product, so this is a real requirement rather than a nicety.
      is_complete: facts.approved_photo_count >= 1,
    },
    // Batch 5 adds: at least one enabled mode.
    {
      key: 'mode',
      // spec §5.2: signup picks a primary mode. An account with none enabled
      // has no deck to show, so onboarding is not finished without one.
      label: 'Choose what you are here for',
      is_complete: enabledModes >= 1,
    },
  ];

  const missing = steps.filter((step) => !step.is_complete).map((step) => step.key);

  return {
    is_complete: user.onboarded_at !== null && user.status === UserStatus.active,
    can_complete: missing.length === 0,
    status: user.status,
    completed_at: user.onboarded_at?.toISOString() ?? null,
    steps,
    missing,
  };
}

/**
 * Advances `pending -> active`.
 *
 * Idempotent: completing twice is a no-op rather than an error, because a
 * retried request on a flaky mobile connection must not read as a failure.
 */
export async function completeOnboarding(userId: string): Promise<OnboardingStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, date_of_birth: true, onboarded_at: true },
  });

  if (!user) {
    throw ApiError.notFound();
  }

  if (user.status === UserStatus.suspended) {
    throw new ApiError(ERROR_CODES.ACCOUNT_SUSPENDED);
  }

  if (user.onboarded_at) {
    return getOnboardingStatus(userId);
  }

  const status = await getOnboardingStatus(userId);

  if (!status.can_complete) {
    throw new ApiError(
      ERROR_CODES.ONBOARDING_INCOMPLETE,
      'Finish setting up your profile to continue.',
      { missing: status.missing },
    );
  }

  // spec §5.1: the legal check runs wherever a date of birth is used to admit
  // someone, not only at email registration. A social signup reaches the
  // product for the first time here.
  if (!user.date_of_birth) {
    throw ApiError.validation({ date_of_birth: ['Enter your date of birth.'] });
  }
  assertAdult(user.date_of_birth);

  await prisma.user.update({
    where: { id: userId },
    data: { status: UserStatus.active, onboarded_at: new Date() },
  });

  logger.info({ user_id: userId }, 'onboarding completed');

  return getOnboardingStatus(userId);
}

/**
 * Sets a date of birth for an account that has none, applying the under-18
 * check. Refuses to change one that is already set — a birth date is not
 * something a user edits freely, and letting them would reopen the age gate.
 */
export async function setDateOfBirth(userId: string, isoDate: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { date_of_birth: true },
  });

  if (!user) {
    throw ApiError.notFound();
  }

  if (user.date_of_birth) {
    throw new ApiError(
      ERROR_CODES.CONFLICT,
      'Your date of birth is already set. Contact support if it is wrong.',
    );
  }

  const dateOfBirth = new Date(`${isoDate}T00:00:00Z`);
  assertAdult(dateOfBirth);

  await prisma.user.update({
    where: { id: userId },
    data: { date_of_birth: dateOfBirth },
  });
}
