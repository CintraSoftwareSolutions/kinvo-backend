export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

export const SERVICE_NAME = 'kinvo-api';

export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

export const TOKEN_LIFETIMES = {
  ACCESS_SECONDS: 30 * 60,
  REFRESH_SECONDS: 60 * 24 * 60 * 60,
} as const;

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_MAX_LENGTH = 128;
export const CLIENT_HEADERS = {
  APP_VERSION: 'x-app-version',
  PLATFORM: 'x-platform',
  DEVICE_ID: 'x-device-id',
  DEVICE_MODEL: 'x-device-model',
  OS_VERSION: 'x-os-version',
} as const;

export const DISCOVERY = {
  DECK_SIZE: 50,
  CANDIDATE_POOL: 500,
  VERIFIED_SCORE_BONUS: 25,
  BOOST_SCORE_BONUS: 40,
  RECENCY_SCORE_MAX: 20,
  RECENCY_WINDOW_HOURS: 72,
  PROXIMITY_SCORE_MAX: 15,
  BOOST_DURATION_MINUTES: 30,
  MATCH_EXPIRY_DAYS: 14,
  MATCH_EXTENSION_DAYS: 7,
} as const;
