import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env before reading process.env. In test runs the harness (tests/setup.ts)
// has already populated process.env, and dotenv never overwrites existing keys.
loadDotenv();

/** An empty variable means unset: compose files and `.env` templates carry empty keys. */
const blankIsUnset = (value: unknown): unknown => (value === '' ? undefined : value);

/** A web page the app may open as it is, so only ever a secure one. */
const httpsPage = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'must be an https:// address' });

/**
 * Spec 7 / Batch 0: the process must crash on a missing or invalid required
 * variable rather than boot half-configured.
 */
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

  /**
   * Ceiling for the catch-all rate limiter, per IP per 15 minutes.
   *
   * Configurable for two reasons. A load test drives thousands of requests from
   * ONE address and would otherwise measure this limiter rather than the
   * endpoint — 300 successes followed by 429s, which is exactly what the first
   * deck run produced.
   *
   * The second reason is not about testing. This limiter is keyed on IP, and
   * mobile users sit behind carrier NAT in large groups, so a busy cell can
   * share one address between many people. 300 per quarter hour is comfortable
   * for one person and may not be for a hundred sharing an exit node. Being a
   * config value means raising it is a deploy, not a release.
   */
  RATE_LIMIT_GENERAL_MAX: z.coerce.number().int().min(1).default(300),

  // --- Auth (Batch 2) ------------------------------------------------------
  // No defaults, ever. A signing secret with a fallback value is not a secret,
  // and a deployment that silently boots with a known key is forgeable.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('kinvo'),

  /// spec §7 Batch 2: password reset codes are single-use with a one-hour expiry.
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // --- External identity providers ----------------------------------------
  // Optional so development and tests boot without third-party credentials;
  // required in production by the refinement below.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),

  /**
   * LiveKit, for video calls (spec §7, Batch 14; provider changed in Batch 16).
   *
   * An API key pair scoped to one LiveKit project, so a leaked video credential
   * does not also hand over SMS and billing the way a Twilio account token
   * would. `LIVEKIT_URL` is the `wss://` address the apps connect to; the
   * management API is the same host over https, derived rather than configured
   * twice.
   */
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
  // S3 in every environment. Locally that S3 is SeaweedFS, which speaks the same
  // API, so only the endpoint and credentials differ between here and AWS.
  S3_REGION: z.string().min(1).default('us-east-1'),

  /**
   * Set for SeaweedFS, unset for real AWS S3 (the SDK then resolves the regional
   * endpoint itself).
   */
  S3_ENDPOINT: z.string().url().optional(),

  /**
   * SeaweedFS addresses buckets as a path (host/bucket/key); AWS uses a virtual
   * host (bucket.host/key). Must be true against SeaweedFS.
   */
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /** Profile photos, chat media, and voice notes. */
  S3_MEDIA_BUCKET: z.string().min(1).default('kinvo-media'),

  /**
   * spec §7 Batch 4: verification documents live in a SEPARATE private bucket
   * with stricter lifecycle rules. Government ID images are the most sensitive
   * data in this system and must never share a bucket policy with selfies.
   */
  S3_VERIFICATION_BUCKET: z.string().min(1).default('kinvo-verification'),

  /** Lifetime of a presigned upload URL. Short: it is used immediately. */
  S3_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  /**
   * Lifetime of a presigned download URL. Longer, because the client caches
   * images — but still finite, so a leaked URL expires. Replaced by CDN signed
   * URLs if a CDN is adopted (open decision, recorded in DECISIONS.md).
   */
  S3_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(3600),

  /** Verification documents get a much shorter window than profile photos. */
  S3_VERIFICATION_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  /**
   * Firebase service-account JSON, as one string (spec §3, Batch 11).
   *
   * Held in SSM Parameter Store and injected as an environment variable rather
   * than written to disk on the instance — a key file on a box is a key file
   * that gets copied into a backup, an image, or a support ticket.
   *
   * Absent, push falls back to a no-op. That is safe only because every
   * notification is persisted to the feed first, so the user still sees it in
   * the app; they simply get no banner.
   */
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  /**
   * Amazon SES (spec §3, Batch 11).
   *
   * Preferred over SMTP because it needs no static credentials: the instance
   * role signs the calls, exactly as it does for S3. Setting a sender address
   * is what switches email on.
   *
   * SES suppresses bounced and complained addresses at the ACCOUNT level, so
   * the application keeps no suppression list of its own — the platform
   * refuses to send to a dead address without being asked.
   */
  SES_SENDER_ADDRESS: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),

  /**
   * SMTP. All four must be present together or email falls back to a no-op —
   * a half-configured transport fails at send time, which is the worst place
   * to discover it.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  /**
   * Where emergency alerts are copied for the safety team (spec §5.7). Without
   * it, only the user's trusted contacts are emailed.
   */
  SAFETY_ALERT_EMAIL: z.string().email().optional(),

  /**
   * Whether Twilio, Google, and Apple credentials must be present in production.
   *
   * Defaults true, and must stay true anywhere real users sign in: without it,
   * OTP and social sign-in fail at a user's first request rather than at deploy
   * time, which is far harder to notice.
   *
   * A staging environment that legitimately has no such accounts yet sets this
   * false. The endpoints then return SERVICE_UNAVAILABLE when called, which is
   * honest, instead of the whole API refusing to boot.
   */
  REQUIRE_THIRD_PARTY_INTEGRATIONS: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  /**
   * Serve browsable API docs at /docs.
   *
   * On by default: staging exists so the mobile team can read the contract, and
   * the endpoint list is not a secret — every one of them is reachable by
   * anyone with the base URL regardless. Set false on a production deployment
   * that would rather not advertise its surface.
   */
  DOCS_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  /**
   * Test purchases: tapping Upgrade grants the plan with no payment taken
   * (DECISIONS.md, 24 Sep 2026). A stand-in so the paid tiers can be exercised
   * before RevenueCat exists.
   *
   * Off unless set to exactly "true", and refused at boot wherever the
   * integration waiver is off — that is, wherever real users sign in and pay.
   * A switch that gives Premium away for free must not be one typo from
   * production.
   */
  TEST_PURCHASES_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Phone sign-in (DECISIONS.md, 25 Sep 2026). On unless set to "false", as
   * the spec asks. Off where the Twilio account cannot text anyone yet, so the
   * app stops offering a button that can only fail: GET /config says so, and
   * the code endpoints refuse before Twilio is called.
   */
  PHONE_SIGN_IN_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  /**
   * Where people get help and read the rules, served by GET /config so the
   * app's Support screen and sign-up line can link to them (DECISIONS.md,
   * 25 Sep 2026). Each is optional, and the app shows only those set: a link
   * to nowhere is worse than none. Pages must be https, since the app opens
   * them as they are.
   */
  SUPPORT_EMAIL: z.preprocess(blankIsUnset, z.string().email().optional()),
  HELP_CENTER_URL: z.preprocess(blankIsUnset, httpsPage.optional()),
  COMMUNITY_GUIDELINES_URL: z.preprocess(blankIsUnset, httpsPage.optional()),
  TERMS_URL: z.preprocess(blankIsUnset, httpsPage.optional()),
  PRIVACY_POLICY_URL: z.preprocess(blankIsUnset, httpsPage.optional()),
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

/**
 * Pure parser, exported so tests can exercise validation without touching the
 * real process environment or resetting the module registry.
 */
/**
 * Credentials that development and test may omit but production may not.
 * Booting production without them would mean OTP and social sign-in failing at
 * the first real request instead of at deploy time.
 */
/**
 * S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are deliberately NOT in this list.
 *
 * On AWS the instance supplies credentials through its IAM role, so there are
 * no static keys to set — that is the better practice, and demanding them here
 * would force a long-lived secret onto the box for no reason. The SDK resolves
 * the role automatically; the variables exist only for SeaweedFS locally.
 */
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

  /**
   * The two signing keys must differ. If they are the same, the only thing
   * separating an access token from a refresh token is the `type` claim, and a
   * single missed check anywhere turns a 30-minute token into a 60-day one.
   */
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

/**
 * Whether test purchases are on: the route that grants them answers, and the
 * plans it granted count.
 *
 * A function rather than a constant so the suites that assert both states can
 * flip it. Checks the waiver as well as the switch, although a boot with both
 * is refused above — the refusal is the lock, and this is the second one, for
 * the day somebody loosens the first.
 */
export function testPurchasesEnabled(): boolean {
  return env.TEST_PURCHASES_ENABLED && !thirdPartyIntegrationsRequired;
}
