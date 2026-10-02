import { ApiError } from '@utils/api-error';

export const MINIMUM_AGE = 18;

export function calculateAge(dateOfBirth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  const dayDelta = now.getUTCDate() - dateOfBirth.getUTCDate();

  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }

  return age;
}

export function isAdult(dateOfBirth: Date, now: Date = new Date()): boolean {
  return calculateAge(dateOfBirth, now) >= MINIMUM_AGE;
}

export function assertAdult(dateOfBirth: Date, field = 'date_of_birth'): void {
  if (Number.isNaN(dateOfBirth.getTime())) {
    throw ApiError.validation({ [field]: ['Enter a valid date of birth.'] });
  }

  if (dateOfBirth.getTime() > Date.now()) {
    throw ApiError.validation({ [field]: ['Date of birth cannot be in the future.'] });
  }

  if (!isAdult(dateOfBirth)) {
    throw ApiError.validation({
      [field]: [`You must be at least ${MINIMUM_AGE} to use Kinvo.`],
    });
  }
}

export function dateOfBirthRangeForAges(
  minAge: number,
  maxAge: number,
  now: Date = new Date(),
): { gt: Date; lte: Date } {
  const youngest = new Date(
    Date.UTC(now.getUTCFullYear() - minAge, now.getUTCMonth(), now.getUTCDate()),
  );

  const oldest = new Date(
    Date.UTC(now.getUTCFullYear() - maxAge - 1, now.getUTCMonth(), now.getUTCDate()),
  );

  return { gt: oldest, lte: youngest };
}
