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

export const UNLIMITED = -1;

export type EntitlementMap = Record<EntitlementKey, boolean | number>;

export interface QuotaState {
  limit: number;
  used: number;
  remaining: number;
  is_unlimited: boolean;
  resets_at: string;
}
