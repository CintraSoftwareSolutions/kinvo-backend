import { ApiError } from '@utils/api-error';

/**
 * Age handling (spec §5.1).
 *
 * The database stores a date of birth and never an age integer — an age is
 * wrong the day after it is written. Everything that needs an age computes it
 * here.
 */

export const MINIMUM_AGE = 18;

/**
 * Whole years elapsed, in UTC.
 *
 * Compares month and day rather than dividing elapsed milliseconds: leap years
 * make the arithmetic approach wrong by a day, which matters precisely at the
 * eighteenth birthday.
 */
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

/**
 * spec §5.1: reject under-18. Legal requirement, so it is enforced wherever a
 * date of birth is set — not only at email registration, because social and
 * phone signup supply one later.
 *
 * Reported as a field validation failure so the app can highlight the input.
 * The message never states the stored date back to the user.
 */
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

/**
 * The date-of-birth window matching an inclusive age range.
 *
 * Filtering the deck by age has to become a date comparison, because the
 * database stores a date of birth and computing an age per candidate row would
 * make the GIST and B-tree indexes useless.
 *
 * Both bounds are inclusive of the age, which is why `gt` is strict on the
 * older end: someone whose 40th birthday is today is 40, and must still appear
 * for a maximum of 40. Using `gte` there would drop them on their birthday.
 */
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
