import {
  type EntitlementKey,
  type EntitlementMap,
  UNLIMITED,
} from '@modules/entitlements/entitlements.types';

type Line = (plan: EntitlementMap, free: EntitlementMap) => string | null;

function limit(key: EntitlementKey, unlimited: string, counted: (value: number) => string): Line {
  return (plan, free) => {
    const mine = plan[key] as number;
    const theirs = free[key] as number;

    if (mine === UNLIMITED) return theirs === UNLIMITED ? null : unlimited;
    if (theirs === UNLIMITED || mine <= theirs) return null;
    return counted(mine);
  };
}

function feature(key: EntitlementKey, text: string): Line {
  return (plan, free) => (plan[key] === true && free[key] !== true ? text : null);
}

const LINES: Record<EntitlementKey, Line | null> = {
  daily_swipe_limit: limit('daily_swipe_limit', 'Unlimited likes', (n) => `${n} likes a day`),
  daily_message_limit: limit(
    'daily_message_limit',
    'Unlimited messages',
    (n) => `${n} messages a day`,
  ),
  see_who_liked_you: feature('see_who_liked_you', 'See who liked you'),
  advanced_filters: feature('advanced_filters', 'Filter by interests and goals'),
  rewind: feature('rewind', 'Undo your last swipe'),
  boost: feature('boost', 'Boost your profile'),
  extend_matches: feature('extend_matches', 'Extend a match before it expires'),
  max_simultaneous_modes: limit(
    'max_simultaneous_modes',
    'Every mode at once',
    (n) => `Up to ${n} modes at once`,
  ),
  // The one flag where false is the benefit.
  show_ads: (plan, free) => (plan.show_ads === false && free.show_ads === true ? 'No ads' : null),
  // Everybody has these.
  standard_discovery: null,
  basic_filters: null,
};

export function describePlan(plan: EntitlementMap, free: EntitlementMap): string[] {
  const lines: string[] = [];

  for (const line of Object.values(LINES)) {
    const text = line?.(plan, free);
    if (text) lines.push(text);
  }

  return lines;
}
