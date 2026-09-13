import { ApiError } from '@utils/api-error';
import { MINIMUM_AGE, assertAdult, calculateAge, isAdult } from '@utils/age';

/**
 * spec §5.1: store date of birth, never an age integer, and reject under-18.
 * Pure logic, so this is a unit test — the birthday-boundary cases are exactly
 * where a naive milliseconds-divided-by-a-year implementation goes wrong.
 */

const NOW = new Date('2026-08-14T12:00:00Z');

describe('calculateAge', () => {
  it('counts whole years elapsed', () => {
    expect(calculateAge(new Date('1999-03-14T00:00:00Z'), NOW)).toBe(27);
  });

  it('does not count a birthday that has not happened yet this year', () => {
    expect(calculateAge(new Date('1999-12-25T00:00:00Z'), NOW)).toBe(26);
  });

  it('counts the birthday on the day itself', () => {
    expect(calculateAge(new Date('2000-08-14T00:00:00Z'), NOW)).toBe(26);
  });

  it('does not count the day before the birthday', () => {
    expect(calculateAge(new Date('2000-08-15T00:00:00Z'), NOW)).toBe(25);
  });

  it('handles a 29 February birthday without drifting', () => {
    // 2024-02-29 to 2026-08-14 is two full years plus change. Dividing elapsed
    // milliseconds by 365.25 days gets this wrong.
    expect(calculateAge(new Date('2024-02-29T00:00:00Z'), NOW)).toBe(2);
  });

  it('is correct across a leap year for an 18th birthday', () => {
    const leapBaby = new Date('2008-02-29T00:00:00Z');

    expect(calculateAge(leapBaby, new Date('2026-02-28T12:00:00Z'))).toBe(17);
    expect(calculateAge(leapBaby, new Date('2026-03-01T12:00:00Z'))).toBe(18);
  });

  it('returns 0 for someone born today', () => {
    expect(calculateAge(new Date('2026-08-14T00:00:00Z'), NOW)).toBe(0);
  });
});

describe('isAdult', () => {
  it('is true on the eighteenth birthday', () => {
    expect(isAdult(new Date('2008-08-14T00:00:00Z'), NOW)).toBe(true);
  });

  it('is false one day short', () => {
    expect(isAdult(new Date('2008-08-15T00:00:00Z'), NOW)).toBe(false);
  });

  it('uses 18 as the threshold', () => {
    expect(MINIMUM_AGE).toBe(18);
  });
});

describe('assertAdult', () => {
  function yearsAgo(years: number): Date {
    const date = new Date();
    date.setUTCFullYear(date.getUTCFullYear() - years);
    return date;
  }

  it('passes for an adult', () => {
    expect(() => assertAdult(yearsAgo(30))).not.toThrow();
  });

  it('throws a field-keyed validation error for a minor', () => {
    try {
      assertAdult(yearsAgo(15));
      throw new Error('expected assertAdult to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe('VALIDATION_FAILED');
      expect(apiError.statusCode).toBe(400);
      expect(apiError.details).toHaveProperty('date_of_birth');
    }
  });

  it('rejects a future date', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);

    expect(() => assertAdult(future)).toThrow(ApiError);
  });

  it('rejects an unparseable date', () => {
    expect(() => assertAdult(new Date('not a date'))).toThrow(ApiError);
  });

  it('reports against a caller-chosen field name', () => {
    try {
      assertAdult(yearsAgo(10), 'dob');
      throw new Error('expected assertAdult to throw');
    } catch (error) {
      expect((error as ApiError).details).toHaveProperty('dob');
    }
  });

  it('never echoes the submitted date back to the user', () => {
    try {
      assertAdult(new Date('2015-06-15T00:00:00Z'));
      throw new Error('expected assertAdult to throw');
    } catch (error) {
      expect(JSON.stringify((error as ApiError).details)).not.toContain('2015');
    }
  });
});
