import { addMonths } from '@utils/calendar';

/**
 * A test plan's period is the one number a tester reads straight off the
 * screen ("Premium until …"), so a month that quietly became thirty-one days,
 * or a February that spilled into March, would be the first thing noticed.
 */
describe('addMonths', () => {
  const at = (iso: string): Date => new Date(iso);

  it('adds calendar months, keeping the time of day', () => {
    expect(addMonths(at('2026-09-24T07:13:30.000Z'), 1).toISOString()).toBe(
      '2026-10-24T07:13:30.000Z',
    );
    expect(addMonths(at('2026-09-24T07:13:30.000Z'), 12).toISOString()).toBe(
      '2027-09-24T07:13:30.000Z',
    );
  });

  it('clamps to the end of a shorter month instead of spilling into the next', () => {
    expect(addMonths(at('2027-01-31T10:00:00.000Z'), 1).toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
    expect(addMonths(at('2028-01-31T10:00:00.000Z'), 1).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
    expect(addMonths(at('2026-08-31T10:00:00.000Z'), 1).toISOString()).toBe(
      '2026-09-30T10:00:00.000Z',
    );
  });

  it('ends a year bought on 29 February on the 28th', () => {
    expect(addMonths(at('2028-02-29T10:00:00.000Z'), 12).toISOString()).toBe(
      '2029-02-28T10:00:00.000Z',
    );
  });

  it('crosses the year end', () => {
    expect(addMonths(at('2026-12-15T10:00:00.000Z'), 1).toISOString()).toBe(
      '2027-01-15T10:00:00.000Z',
    );
    expect(addMonths(at('2026-11-30T10:00:00.000Z'), 3).toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
  });

  it('leaves the date it was given alone', () => {
    const from = at('2026-09-24T07:13:30.000Z');
    addMonths(from, 1);
    expect(from.toISOString()).toBe('2026-09-24T07:13:30.000Z');
  });
});
