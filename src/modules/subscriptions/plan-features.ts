import {
  type EntitlementKey,
  type EntitlementMap,
  UNLIMITED,
} from '@modules/entitlements/entitlements.types';

/**
 * The paywall's bullet points: what a plan adds over the free tier, in words.
 *
 * Written from the entitlement matrix rather than typed into the app, because
 * which features are paid for is DATA (spec §5.11) — several rows are still
 * provisional — and a plan description that drifted from what the plan unlocks
 * is a support problem and a store-review problem at once. Moving a feature
 * between tiers is a seed edit, and this list follows it with no release.
 *
 * Only what paying ADDS is listed: a line appears when the plan's value beats
 * the free tier's. A feature everybody has is not a reason to buy anything.
 */

type Line = (plan: EntitlementMap, free: EntitlementMap) => string | null;

/** A numeric limit, when the plan's beats the free tier's. */
function limit(key: EntitlementKey, unlimited: string, counted: (value: number) => string): Line {
  return (plan, free) => {
    const mine = plan[key] as number;
    const theirs = free[key] as number;

    if (mine === UNLIMITED) return theirs === UNLIMITED ? null : unlimited;
    if (theirs === UNLIMITED || mine <= theirs) return null;
    return counted(mine);
  };
}

/** A feature the plan has and the free tier does not. */
function feature(key: EntitlementKey, text: string): Line {
  return (plan, free) => (plan[key] === true && free[key] !== true ? text : null);
}

/**
 * Every flag, in the order a person weighs a plan: limits first, then what can
 * be seen, then extras.
 *
 * A Record over EntitlementKey, so a flag added to the vocabulary without a
 * decision here is a compile error rather than a feature nobody is told about.
 * `null` is that decision made: never listed.
 */
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

/** What [plan] adds over [free], as the paywall shows it. */
export function describePlan(plan: EntitlementMap, free: EntitlementMap): string[] {
  const lines: string[] = [];

  for (const line of Object.values(LINES)) {
    const text = line?.(plan, free);
    if (text) lines.push(text);
  }

  return lines;
}
