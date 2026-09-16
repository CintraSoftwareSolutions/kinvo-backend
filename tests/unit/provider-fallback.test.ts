/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
/**
 * Provider selection under the integration waiver (spec §7).
 *
 * The lint exemptions above are load-bearing, not laziness.
 * `thirdPartyIntegrationsRequired` is a const computed when `@config/env` is
 * first imported, and the providers cache their choice. A static import would
 * therefore bind ONE environment for the whole file and could not exercise the
 * branch this suite exists to cover. `jest.isolateModules` is synchronous, so
 * `require` is the only way to re-enter the module registry.
 *
 * WHY THIS FILE EXISTS. `REQUIRE_THIRD_PARTY_INTEGRATIONS=false` lets a
 * deployed environment run without Twilio, Google or Apple accounts. Staging
 * uses it, and staging also runs with `NODE_ENV=production`.
 *
 * Both the OTP provider and the video provider originally branched on
 * `isProduction` alone, so on staging they threw a raw Error and the endpoint
 * answered 500 instead of falling back to its stub. Phone sign-in was broken
 * there from Batch 2 and nobody noticed, because the existing tests only
 * covered env PARSING — whether the waiver let the process boot — and never
 * which provider the waiver then selected.
 *
 * These tests cover the selection, because that is where the bug was.
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://kinvo:kinvo@localhost:5432/kinvo',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a-sufficiently-long-access-secret-for-tests-0001',
  JWT_REFRESH_SECRET: 'a-sufficiently-long-refresh-secret-for-tests-002',
  // Production refuses a wildcard, and this must exercise the production path.
  CORS_ORIGINS: 'https://admin.kinvo.app',
  // Production also demands a mail transport. That rule has its own test in
  // config.test.ts; this file is about which provider the waiver selects, and
  // tripping over an unrelated rule here would say nothing about that.
  SES_SENDER_ADDRESS: 'no-reply@kinvo.app',
};

const TWILIO_CREDENTIALS: NodeJS.ProcessEnv = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'auth-token',
  TWILIO_VERIFY_SERVICE_SID: 'VA00000000000000000000000000000000',
  TWILIO_API_KEY_SID: 'SK00000000000000000000000000000000',
  TWILIO_API_KEY_SECRET: 'api-key-secret',
  GOOGLE_OAUTH_CLIENT_IDS: 'client-id.apps.googleusercontent.com',
  APPLE_CLIENT_IDS: 'com.kinvo.app',
};

/**
 * Re-imports the config and provider modules against a given environment.
 *
 * `thirdPartyIntegrationsRequired` is computed once at module load, and the
 * providers cache their selection, so the module registry has to be reset for
 * each case rather than the values poked afterwards.
 */
function loadWith<T>(overrides: NodeJS.ProcessEnv, read: () => T): T {
  const saved = process.env;
  process.env = { ...saved, ...overrides };

  try {
    let result!: T;
    jest.isolateModules(() => {
      result = read();
    });
    return result;
  } finally {
    process.env = saved;
  }
}

describe('the integration waiver selects stubs rather than throwing', () => {
  it('falls back to the OTP stub on a waived production environment', () => {
    // Exactly staging: NODE_ENV=production, waiver on, no Twilio account.
    const provider = loadWith(
      {
        ...BASE_ENV,
        NODE_ENV: 'production',
        REQUIRE_THIRD_PARTY_INTEGRATIONS: 'false',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_AUTH_TOKEN: '',
        TWILIO_VERIFY_SERVICE_SID: '',
      },
      () =>
        (
          require('@/providers/twilio.provider') as typeof import('@/providers/twilio.provider')
        ).getOtpProvider(),
    );

    // Before the fix this threw, and /auth/otp/send answered 500.
    expect(provider).toBeDefined();
  });

  it('falls back to the video stub on a waived production environment', () => {
    const provider = loadWith(
      {
        ...BASE_ENV,
        NODE_ENV: 'production',
        REQUIRE_THIRD_PARTY_INTEGRATIONS: 'false',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_API_KEY_SID: '',
        TWILIO_API_KEY_SECRET: '',
      },
      () =>
        (
          require('@/providers/video.provider') as typeof import('@/providers/video.provider')
        ).getVideoProvider(),
    );

    expect(provider.name).toBe('stub');
    expect(provider.isConfigured).toBe(false);
  });

  it('issues a stub token that could never authenticate against Twilio', () => {
    const token = loadWith(
      {
        ...BASE_ENV,
        NODE_ENV: 'production',
        REQUIRE_THIRD_PARTY_INTEGRATIONS: 'false',
        TWILIO_API_KEY_SID: '',
        TWILIO_API_KEY_SECRET: '',
      },
      () =>
        (require('@/providers/video.provider') as typeof import('@/providers/video.provider'))
          .getVideoProvider()
          .issueToken({ roomName: 'kinvo-call-abc', userId: 'user-1' }),
    );

    // A plausible-looking fake would be worse than an obvious one: a client
    // would believe it had connected when it had not.
    expect(token.token).not.toMatch(/^ey/);
    expect(token.token).toContain('not-a-jwt');
    // Still scoped to the room it was asked for, stub or not.
    expect(token.room_name).toBe('kinvo-call-abc');
  });
});

describe('the hard stop still fires where it matters', () => {
  it('throws for OTP in real production, where the waiver is off', () => {
    expect(() =>
      loadWith(
        {
          ...BASE_ENV,
          NODE_ENV: 'production',
          REQUIRE_THIRD_PARTY_INTEGRATIONS: 'true',
          TWILIO_ACCOUNT_SID: '',
          TWILIO_AUTH_TOKEN: '',
          TWILIO_VERIFY_SERVICE_SID: '',
        },
        () =>
          (
            require('@/providers/twilio.provider') as typeof import('@/providers/twilio.provider')
          ).getOtpProvider(),
      ),
    ).toThrow();
  });

  it('throws for video in real production, where the waiver is off', () => {
    // Env validation should already have refused this boot. The provider keeps
    // its own stop in case that validation is ever loosened — handing out fake
    // video tokens in production would present as a broken client rather than
    // a missing credential.
    expect(() =>
      loadWith(
        {
          ...BASE_ENV,
          NODE_ENV: 'production',
          REQUIRE_THIRD_PARTY_INTEGRATIONS: 'true',
          TWILIO_API_KEY_SID: '',
          TWILIO_API_KEY_SECRET: '',
        },
        () =>
          (
            require('@/providers/video.provider') as typeof import('@/providers/video.provider')
          ).getVideoProvider(),
      ),
    ).toThrow();
  });

  it('uses the real provider whenever credentials are present', () => {
    const provider = loadWith({ ...BASE_ENV, ...TWILIO_CREDENTIALS, NODE_ENV: 'production' }, () =>
      (
        require('@/providers/video.provider') as typeof import('@/providers/video.provider')
      ).getVideoProvider(),
    );

    expect(provider.name).toBe('twilio');
    expect(provider.isConfigured).toBe(true);
  });
});
