import { clampLimit, decodeCursor, encodeCursor, paginate } from '@utils/cursor';
import { dateOfBirthRangeForAges } from '@utils/age';
import { orderPair } from '@modules/matches/match.service';

/**
 * Pure helpers behind cursor pagination and matching (Batch 7). No database:
 * these are the pieces whose edge cases are cheapest to pin down directly.
 */

describe('cursors', () => {
  it('round-trips a payload', () => {
    const encoded = encodeCursor({ k: 42, id: 'abc' });

    expect(decodeCursor(encoded)).toEqual({ k: 42, id: 'abc' });
  });

  it('is opaque — the client cannot read an id out of it by eye', () => {
    const encoded = encodeCursor({ k: 1, id: 'user-123' });

    expect(encoded).not.toContain('user-123');
  });

  it('is URL-safe, so it survives a query string unescaped', () => {
    const encoded = encodeCursor({ k: '2026-08-26T12:00:00.000Z', id: 'x'.repeat(40) });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a mangled cursor as a client error', () => {
    expect(() => decodeCursor('%%%not-base64%%%')).toThrow();
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow();
  });
});

describe('paginate', () => {
  it('reports has_more from the extra row and does not return it', () => {
    const rows = [1, 2, 3];

    const page = paginate(rows, 2, (n) => ({ k: n, id: String(n) }));

    expect(page.items).toEqual([1, 2]);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).not.toBeNull();
  });

  it('returns a null cursor on the last page rather than one that yields nothing', () => {
    const page = paginate([1, 2], 5, (n) => ({ k: n, id: String(n) }));

    expect(page.items).toEqual([1, 2]);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = paginate([], 20, () => ({ k: 0, id: '' }));

    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });
});

describe('clampLimit', () => {
  it('defaults, floors, and caps (spec §4.5)', () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1000)).toBe(100);
    expect(clampLimit(15)).toBe(15);
  });
});

describe('dateOfBirthRangeForAges', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('includes someone on their minimum-age birthday', () => {
    const range = dateOfBirthRangeForAges(25, 30, now);
    const exactly25 = new Date('2001-08-26T00:00:00Z');

    expect(exactly25.getTime()).toBeLessThanOrEqual(range.lte.getTime());
  });

  it('includes someone on their maximum-age birthday', () => {
    const range = dateOfBirthRangeForAges(25, 30, now);
    const exactly30 = new Date('1996-08-26T00:00:00Z');

    // Turning 30 today still counts as 30, so `gt` must be strict on this end.
    expect(exactly30.getTime()).toBeGreaterThan(range.gt.getTime());
  });

  it('excludes someone a day too old', () => {
    const range = dateOfBirthRangeForAges(25, 30, now);
    const justTurned31 = new Date('1995-08-25T00:00:00Z');

    expect(justTurned31.getTime()).toBeLessThanOrEqual(range.gt.getTime());
  });

  it('excludes someone a day too young', () => {
    const range = dateOfBirthRangeForAges(25, 30, now);
    const nearly25 = new Date('2001-08-27T00:00:00Z');

    expect(nearly25.getTime()).toBeGreaterThan(range.lte.getTime());
  });
});

describe('orderPair', () => {
  it('produces the same ordered pair from either direction', () => {
    const a = '00000000-0000-4000-8000-00000000000a';
    const b = '00000000-0000-4000-8000-00000000000b';

    // Without this, (A,B) and (B,A) could both be inserted and the unique
    // index would not stop it.
    expect(orderPair(a, b)).toEqual(orderPair(b, a));
    expect(orderPair(b, a)[0] < orderPair(b, a)[1]).toBe(true);
  });
});
