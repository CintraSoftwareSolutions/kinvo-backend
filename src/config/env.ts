import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const blankIsUnset = (value: unknown): unknown => (value === '' ? undefined : value);

const httpsPage = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'must be an https:// address' });
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    }),

  REDIS_URL: z
    .string()
    .min(1)
    .refine((value) => /^rediss?:\/\//.test(value), {
      message: 'REDIS_URL must be a redis:// or rediss:// connection string',
    }),

  // Comma-separated list. "*" allows any origin (development only).
  CORS_ORIGINS: z
    .string()
    .default('*')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // Accepted by express.json / express.urlencoded (e.g. "1mb", "512kb").
  JSON_BODY_LIMIT: z.string().min(2).default('1mb'),
  RATE_LIMIT_GENERAL_MAX: z.coerce.number().int().min(1).default(300),

  // --- Auth (Batch 2) ------------------------------------------------------

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('kinvo'),

  /// spec §7 Batch 2: password reset codes are single-use with a one-hour expiry.
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // --- External identity providers ----------------------------------------

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),
  LIVEKIT_URL: z.preprocess(
    // An empty variable means unset, not a malformed URL. Compose files and
    // `.env` templates carry empty keys, and refusing to boot over one would
    // stop an environment that is deliberately running without video.
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .url()
      .refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), {
        message: 'must be the wss:// address of the LiveKit project',
      })
      .optional(),
  ),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  // Comma-separated: iOS, Android, and web client IDs are all valid audiences.
  GOOGLE_OAUTH_CLIENT_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),

  // Comma-separated Apple bundle identifiers / service IDs.
  APPLE_CLIENT_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),

  // --- Media storage (Batch 4) --------------------------------------------

  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_MEDIA_BUCKET: z.string().min(1).default('kinvo-media'),
  S3_VERIFICATION_BUCKET: z.string().min(1).default('kinvo-verification'),
  S3_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  S3_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(3600),
  S3_VERIFICATION_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  SES_SENDER_ADDRESS: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SAFETY_ALERT_EMAIL: z.string().email().optional(),

  REQUIRE_THIRD_PARTY_INTEGRATIONS: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  DOCS_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  TEST_PURCHASES_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  PHONE_SIGN_IN_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  SUPPORT_EMAIL: z.preprocess(blankIsUnset, z.string().email().optional()),
  HELP_CENTER_URL: z.preprocess(blankIsUnset, httpsPage.optional()),
  COMMUNITY_GUIDELINES_URL: z.preprocess(blankIsUnset, httpsPage.optional()),
  TERMS_URL: z.preprocess(blankIsUnset, httpsPage.optional()),
  PRIVACY_POLICY_URL: z.preprocess(blankIsUnset, httpsPage.optional()),

  GEOAPIFY_API_KEY: z.preprocess(blankIsUnset, z.string().min(16).optional()),
  PLACES_DAILY_CREDIT_LIMIT: z.coerce.number().int().min(0).default(2500),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: Record<string, string[]>;

  constructor(issues: Record<string, string[]>) {
    const summary = Object.entries(issues)
      .map(([key, messages]) => `  - ${key}: ${messages.join('; ')}`)
      .join('\n');
    super(`Invalid environment configuration:\n${summary}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

const PRODUCTION_REQUIRED: { key: keyof Env; message: string }[] = [
  { key: 'TWILIO_ACCOUNT_SID', message: 'required in production for OTP delivery' },
  { key: 'TWILIO_AUTH_TOKEN', message: 'required in production for OTP delivery' },
  { key: 'TWILIO_VERIFY_SERVICE_SID', message: 'required in production for OTP delivery' },
  { key: 'LIVEKIT_URL', message: 'required in production for video calls' },
  { key: 'LIVEKIT_API_KEY', message: 'required in production to issue video tokens' },
  { key: 'LIVEKIT_API_SECRET', message: 'required in production to issue video tokens' },
  { key: 'GOOGLE_OAUTH_CLIENT_IDS', message: 'required in production for Google sign-in' },
  { key: 'APPLE_CLIENT_IDS', message: 'required in production for Apple sign-in' },
];

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : '_';
      const bucket = issues[key];
      if (bucket) {
        bucket.push(issue.message);
      } else {
        issues[key] = [issue.message];
      }
    }
    throw new EnvValidationError(issues);
  }

  const issues: Record<string, string[]> = {};

  if (result.data.JWT_ACCESS_SECRET === result.data.JWT_REFRESH_SECRET) {
    issues.JWT_REFRESH_SECRET = ['must be different from JWT_ACCESS_SECRET'];
  }

  if (result.data.NODE_ENV === 'production' && result.data.REQUIRE_THIRD_PARTY_INTEGRATIONS) {
    for (const { key, message } of PRODUCTION_REQUIRED) {
      const value = result.data[key];
      const isEmpty = value === undefined || (Array.isArray(value) ? value.length === 0 : false);
      if (isEmpty) {
        issues[key] = [message];
      }
    }
    const smtpConfigured = Boolean(
      result.data.SMTP_HOST &&
      result.data.SMTP_USER &&
      result.data.SMTP_PASSWORD &&
      result.data.SMTP_FROM,
    );

    if (!result.data.SES_SENDER_ADDRESS && !smtpConfigured) {
      issues.SES_SENDER_ADDRESS = [
        'required in production to deliver password reset email, or set SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM instead',
      ];
    }
  }

  if (
    result.data.NODE_ENV === 'production' &&
    result.data.REQUIRE_THIRD_PARTY_INTEGRATIONS &&
    result.data.TEST_PURCHASES_ENABLED
  ) {
    issues.TEST_PURCHASES_ENABLED = [
      'must be off wherever real users pay — it grants paid plans with no payment taken',
    ];
  }

  if (result.data.NODE_ENV === 'production') {
    // A wildcard origin in production lets any site call the API from a
    // browser. Harmless while the only client is a mobile app, but the admin
    // web console arrives later and this is the moment to refuse it.
    if (result.data.CORS_ORIGINS.includes('*')) {
      issues.CORS_ORIGINS = ['must list explicit origins in production, not "*"'];
    }
  }

  if (Object.keys(issues).length > 0) {
    throw new EnvValidationError(issues);
  }

  return result.data;
}

export const env: Env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

export const thirdPartyIntegrationsRequired = isProduction && env.REQUIRE_THIRD_PARTY_INTEGRATIONS;

export function testPurchasesEnabled(): boolean {
  return env.TEST_PURCHASES_ENABLED && !thirdPartyIntegrationsRequired;
}
