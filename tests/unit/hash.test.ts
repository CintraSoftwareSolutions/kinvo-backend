import { generateSecureToken, safeEquals, sha256 } from '@utils/hash';

describe('generateSecureToken', () => {
  it('produces URL-safe output', () => {
    // Reset links and refresh tokens travel in URLs and JSON; padding or
    // slashes would need escaping at every call site.
    expect(generateSecureToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSecureToken()));
    expect(tokens.size).toBe(500);
  });

  it('defaults to 32 bytes of entropy', () => {
    // base64url of 32 bytes is 43 characters.
    expect(generateSecureToken()).toHaveLength(43);
  });

  it('honours a requested size', () => {
    expect(generateSecureToken(64).length).toBeGreaterThan(80);
  });
});

describe('sha256', () => {
  it('returns 64 lower-case hex characters', () => {
    expect(sha256('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256('kinvo')).toBe(sha256('kinvo'));
  });

  it('differs for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('matches the known digest for a known input', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('safeEquals', () => {
  it('is true for identical strings', () => {
    expect(safeEquals('token-value', 'token-value')).toBe(true);
  });

  it('is false for different strings of equal length', () => {
    expect(safeEquals('token-value', 'token-valve')).toBe(false);
  });

  it('is false for different lengths without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the wrapper must not.
    expect(safeEquals('short', 'considerably longer')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeEquals('', '')).toBe(true);
    expect(safeEquals('', 'x')).toBe(false);
  });
});
