/**
 * Spec 4.1: ship v1 from day one. Additive changes stay in v1; breaking changes
 * would become v2.
 */
export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

export const SERVICE_NAME = 'kinvo-api';

/** Spec 4.5: default limit 20, max 100. */
export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

/** Spec 4.3: access 30 minutes, refresh 60 days. Consumed from Batch 2. */
export const TOKEN_LIFETIMES = {
  ACCESS_SECONDS: 30 * 60,
  REFRESH_SECONDS: 60 * 24 * 60 * 60,
} as const;

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_MAX_LENGTH = 128;

/** Spec 4.11: headers the Flutter app always sends. */
export const CLIENT_HEADERS = {
  APP_VERSION: 'x-app-version',
  PLATFORM: 'x-platform',
  DEVICE_ID: 'x-device-id',
} as const;

/**
 * Discovery and matching (spec §5.3, Batch 7).
 *
 * PROVISIONAL where marked. Open decision #6 (match expiry) is unanswered; the
 * placeholder is recorded in DECISIONS.md §1.2e with the cost of changing it.
 * Values that sell subscriptions are NOT here — daily swipe caps live in the
 * entitlement matrix, because those must be changeable without a deploy.
 */
export const DISCOVERY = {
  /** Cards persisted per user per mode per day. */
  DECK_SIZE: 50,
  /**
   * Rows pulled from PostGIS before the relational filters run. Generous
   * because mode, age, and visibility filtering happen after the radius search
   * — too small a pool yields a short deck in a sparse area rather than an
   * accurate one.
   */
  CANDIDATE_POOL: 500,
  /** spec §5.3: verified users rank higher. A ranking input, not a hard filter. */
  VERIFIED_SCORE_BONUS: 25,
  /** An active boost outranks a verified badge but never bypasses a filter. */
  BOOST_SCORE_BONUS: 40,
  /** Recently active people are more likely to reply, so they surface first. */
  RECENCY_SCORE_MAX: 20,
  RECENCY_WINDOW_HOURS: 72,
  /** Nearer is better, scaled across the user's own radius. */
  PROXIMITY_SCORE_MAX: 15,
  BOOST_DURATION_MINUTES: 30,
  /** PROVISIONAL — open decision #6. */
  MATCH_EXPIRY_DAYS: 14,
  /** PROVISIONAL — open decision #6. Each extension adds this many days. */
  MATCH_EXTENSION_DAYS: 7,
} as const;
