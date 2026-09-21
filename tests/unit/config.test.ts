import { EnvValidationError, env, isTest, parseEnv } from '@config/env';

const VALID: NodeJS.ProcessEnv = {
  // Not 'production': that path additionally demands Twilio, Google, and Apple
  // credentials, which is asserted separately below.
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://kinvo:kinvo@localhost:5432/kinvo',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a-sufficiently-long-access-secret-for-tests-0001',
  JWT_REFRESH_SECRET: 'a-sufficiently-long-refresh-secret-for-tests-002',
};

const PRODUCTION_CREDENTIALS: NodeJS.ProcessEnv = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'auth-token',
  TWILIO_VERIFY_SERVICE_SID: 'VA00000000000000000000000000000000',
  // Batch 14, moved to LiveKit in Batch 16. A key pair scoped to one LiveKit
  // project rather than an account-wide token, so a leaked video credential
  // does not also hand over SMS and billing.
  LIVEKIT_URL: 'wss://kinvo-test.livekit.cloud',
  LIVEKIT_API_KEY: 'APIxxxxxxxxxxxx',
  LIVEKIT_API_SECRET: 'a-livekit-api-secret-for-tests-000000000000',
  GOOGLE_OAUTH_CLIENT_IDS: 'client-id.apps.googleusercontent.com',
  APPLE_CLIENT_IDS: 'com.kinvo.app',
  CORS_ORIGINS: 'https://admin.kinvo.app',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'example-secret',
  // Password reset is emailed, so a transport is part of a complete production
  // environment. See "demands a way to send email in production" below.
  SES_SENDER_ADDRESS: 'no-reply@kinvo.app',
  // Defaults on for development; production refuses it. See the test below.
};

describe('environment validation (spec 7, Batch 0)', () => {
  it('parses a minimal valid environment', () => {
    const parsed = parseEnv(VALID);

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.DATABASE_URL).toBe('postgresql://kinvo:kinvo@localhost:5432/kinvo');
  });

  it('applies documented defaults for optional variables', () => {
    const parsed = parseEnv(VALID);

    expect(parsed.PORT).toBe(3000);
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.JSON_BODY_LIMIT).toBe('1mb');
    expect(parsed.CORS_ORIGINS).toEqual(['*']);
  });

  it('crashes rather than booting half-configured when a required var is missing', () => {
    expect(() => parseEnv({ NODE_ENV: 'development' })).toThrow(EnvValidationError);
  });

  it('names every offending variable in the failure', () => {
    try {
      parseEnv({ NODE_ENV: 'development' });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      expect(Object.keys(issues).sort()).toEqual([
        'DATABASE_URL',
        'JWT_ACCESS_SECRET',
        'JWT_REFRESH_SECRET',
        'REDIS_URL',
      ]);
      expect((error as EnvValidationError).message).toContain('DATABASE_URL');
    }
  });

  it('refuses a signing secret short enough to brute force', () => {
    expect(() => parseEnv({ ...VALID, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv({ ...VALID, JWT_REFRESH_SECRET: 'also-short' })).toThrow(
      EnvValidationError,
    );
  });

  it('gives signing secrets no default value', () => {
    // A secret with a fallback is not a secret. If this ever passes with the
    // keys absent, someone has added a default and every token is forgeable.
    const withoutSecrets = { ...VALID };
    delete withoutSecrets.JWT_ACCESS_SECRET;
    delete withoutSecrets.JWT_REFRESH_SECRET;

    expect(() => parseEnv(withoutSecrets)).toThrow(EnvValidationError);
  });

  it('demands third-party credentials in production but not in development', () => {
    // Development boots without them — OTP and social sign-in are simply
    // unavailable, which is fine locally.
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'development' })).not.toThrow();

    // Production must not start only to fail on the first real request.
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'production' })).toThrow(EnvValidationError);

    expect(() =>
      parseEnv({ ...VALID, ...PRODUCTION_CREDENTIALS, NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it('demands a way to send email in production', () => {
    // Password reset is the reason. Its response is identical whether or not
    // the address is registered — it has to be, or it becomes a way to test
    // which addresses have accounts — so an environment with no transport
    // cannot report the failure. It looks healthy while every reset goes
    // nowhere, and the first report comes from a locked-out user.
    const noMail: NodeJS.ProcessEnv = {
      ...VALID,
      ...PRODUCTION_CREDENTIALS,
      NODE_ENV: 'production',
    };
    delete noMail.SES_SENDER_ADDRESS;

    expect(() => parseEnv(noMail)).toThrow(EnvValidationError);

    // SMTP satisfies it instead, for an environment that is not on AWS.
    const smtp: NodeJS.ProcessEnv = {
      ...noMail,
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'kinvo',
      SMTP_PASSWORD: 'smtp-secret',
      SMTP_FROM: 'no-reply@kinvo.app',
    };

    expect(() => parseEnv(smtp)).not.toThrow();

    // Three of the four is not a transport: a half-configured one fails at
    // send time, which is the worst place to find out.
    const partialSmtp = { ...smtp };
    delete partialSmtp.SMTP_FROM;

    expect(() => parseEnv(partialSmtp)).toThrow(EnvValidationError);

    // The waiver still lets staging run without one, where the code comes back
    // in the response instead.
    expect(() => parseEnv({ ...noMail, REQUIRE_THIRD_PARTY_INTEGRATIONS: 'false' })).not.toThrow();
  });

  it('names which production credential is missing', () => {
    const partial: NodeJS.ProcessEnv = {
      ...VALID,
      ...PRODUCTION_CREDENTIALS,
      NODE_ENV: 'production',
    };
    delete partial.TWILIO_AUTH_TOKEN;

    try {
      parseEnv(partial);
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect((error as EnvValidationError).issues).toHaveProperty('TWILIO_AUTH_TOKEN');
    }
  });

  it('refuses identical access and refresh signing secrets', () => {
    // If they match, only the `type` claim separates a 30-minute token from a
    // 60-day one, and one missed check anywhere collapses that distinction.
    const shared = 'the-very-same-secret-used-for-both-of-them';

    expect(() =>
      parseEnv({ ...VALID, JWT_ACCESS_SECRET: shared, JWT_REFRESH_SECRET: shared }),
    ).toThrow(EnvValidationError);
  });

  it('refuses a wildcard CORS origin in production', () => {
    expect(() =>
      parseEnv({ ...VALID, ...PRODUCTION_CREDENTIALS, NODE_ENV: 'production', CORS_ORIGINS: '*' }),
    ).toThrow(EnvValidationError);

    // Still fine in development, where there is no browser client to protect.
    expect(() => parseEnv({ ...VALID, CORS_ORIGINS: '*' })).not.toThrow();
  });

  it('does NOT demand static S3 credentials in production', () => {
    // On AWS the instance supplies credentials through its IAM role, so there
    // are no static keys to set. Requiring them would force a long-lived secret
    // onto the box to satisfy a check — the worse practice, mandated by us.
    // The variables exist only for MinIO locally.
    const withoutKeys: NodeJS.ProcessEnv = {
      ...VALID,
      ...PRODUCTION_CREDENTIALS,
      NODE_ENV: 'production',
    };
    delete withoutKeys.S3_ACCESS_KEY_ID;
    delete withoutKeys.S3_SECRET_ACCESS_KEY;

    expect(() => parseEnv(withoutKeys)).not.toThrow();
  });

  it('waives third-party credentials only when explicitly told to', () => {
    // Production-safe on everything except the third-party accounts, so this
    // test isolates the waiver rather than tripping over the other rules.
    const noIntegrations: NodeJS.ProcessEnv = {
      ...VALID,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://admin.kinvo.app',
    };

    // Default: production refuses to boot without them, so OTP and social
    // sign-in fail at deploy time rather than at a user's first request.
    expect(() => parseEnv(noIntegrations)).toThrow(EnvValidationError);

    // A staging environment that genuinely has no such accounts yet opts out.
    // The endpoints then return SERVICE_UNAVAILABLE when called, which is
    // honest, rather than the whole API refusing to start.
    expect(() =>
      parseEnv({ ...noIntegrations, REQUIRE_THIRD_PARTY_INTEGRATIONS: 'false' }),
    ).not.toThrow();
  });

  it('still enforces the security rules even when integrations are waived', () => {
    // The waiver covers missing third-party accounts. It must not become a way
    // to smuggle a wildcard CORS origin or unmoderated media into production.
    const waived: NodeJS.ProcessEnv = {
      ...VALID,
      NODE_ENV: 'production',
      REQUIRE_THIRD_PARTY_INTEGRATIONS: 'false',
      CORS_ORIGINS: '*',
    };

    expect(() => parseEnv(waived)).toThrow(EnvValidationError);

    expect(() =>
      parseEnv({
        ...VALID,
        NODE_ENV: 'production',
        REQUIRE_THIRD_PARTY_INTEGRATIONS: 'false',
      }),
    ).toThrow(EnvValidationError);
  });

  it('splits comma-separated social client IDs', () => {
    const parsed = parseEnv({
      ...VALID,
      GOOGLE_OAUTH_CLIENT_IDS: 'ios.apps.googleusercontent.com, web.apps.googleusercontent.com',
    });

    expect(parsed.GOOGLE_OAUTH_CLIENT_IDS).toEqual([
      'ios.apps.googleusercontent.com',
      'web.apps.googleusercontent.com',
    ]);
  });

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(() => parseEnv({ ...VALID, DATABASE_URL: 'mysql://localhost:3306/kinvo' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts both postgres:// and postgresql:// schemes', () => {
    expect(parseEnv({ ...VALID, DATABASE_URL: 'postgres://u:p@h:5432/d' }).DATABASE_URL).toContain(
      'postgres://',
    );
  });

  it('rejects a REDIS_URL that is not a redis connection string', () => {
    expect(() => parseEnv({ ...VALID, REDIS_URL: 'http://localhost:6379' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => parseEnv({ ...VALID, LOG_LEVEL: 'chatty' })).toThrow(EnvValidationError);
  });

  it('coerces PORT from its string environment value', () => {
    expect(parseEnv({ ...VALID, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a PORT that is not a usable number', () => {
    expect(() => parseEnv({ ...VALID, PORT: 'not-a-port' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...VALID, PORT: '70000' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...VALID, PORT: '0' })).toThrow(EnvValidationError);
  });

  it('splits and trims a comma-separated CORS_ORIGINS list', () => {
    const parsed = parseEnv({
      ...VALID,
      CORS_ORIGINS: 'https://admin.kinvo.app, https://kinvo.app ,',
    });

    expect(parsed.CORS_ORIGINS).toEqual(['https://admin.kinvo.app', 'https://kinvo.app']);
  });

  it('exposes the parsed singleton for the current process', () => {
    expect(env.NODE_ENV).toBe('test');
    expect(isTest).toBe(true);
  });
});
