/**
 * The entitlement vocabulary (spec §5.11).
 *
 * These keys are the single source of truth: the seed imports them to build the
 * matrix and the resolver imports them to read it. Defining the strings twice
 * would let a typo in one file silently produce a flag that is always missing —
 * which fails open or closed depending on the call site, and never loudly.
 *
 * Adding a feature flag is: one entry here, one row in the seed. No code
 * branches on a tier name anywhere in this codebase.
 */

export const ENTITLEMENT_KEYS = {
  STANDARD_DISCOVERY: 'standard_discovery',
  DAILY_SWIPE_LIMIT: 'daily_swipe_limit',
  DAILY_MESSAGE_LIMIT: 'daily_message_limit',
  BASIC_FILTERS: 'basic_filters',
  ADVANCED_FILTERS: 'advanced_filters',
  SEE_WHO_LIKED_YOU: 'see_who_liked_you',
  EXTEND_MATCHES: 'extend_matches',
  BOOST: 'boost',
  REWIND: 'rewind',
  MAX_SIMULTANEOUS_MODES: 'max_simultaneous_modes',
  SHOW_ADS: 'show_ads',
} as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[keyof typeof ENTITLEMENT_KEYS];

/**
 * Declared value types, checked against the seeded rows at resolve time. A row
 * whose stored JSON disagrees with this table is a broken seed, and it is far
 * better to find out at the boundary than to have `50` arrive somewhere that
 * expected a boolean and be quietly truthy.
 */
export const FLAG_VALUE_TYPES: Record<EntitlementKey, 'boolean' | 'number'> = {
  standard_discovery: 'boolean',
  daily_swipe_limit: 'number',
  daily_message_limit: 'number',
  basic_filters: 'boolean',
  advanced_filters: 'boolean',
  see_who_liked_you: 'boolean',
  extend_matches: 'boolean',
  boost: 'boolean',
  rewind: 'boolean',
  max_simultaneous_modes: 'number',
  show_ads: 'boolean',
};

export const ALL_ENTITLEMENT_KEYS = Object.values(ENTITLEMENT_KEYS);

/** Numeric flags use -1 for "no limit" (spec §5.11). */
export const UNLIMITED = -1;

/** Every flag for one tier, keyed by flag key. */
export type EntitlementMap = Record<EntitlementKey, boolean | number>;

export interface QuotaState {
  limit: number;
  used: number;
  remaining: number;
  is_unlimited: boolean;
  /** UTC midnight, when the counter resets (spec §5.11). */
  resets_at: string;
}
