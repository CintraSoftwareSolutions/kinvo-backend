import type { EntitlementMap } from '@modules/entitlements/entitlements.types';
import { UNLIMITED } from '@modules/entitlements/entitlements.types';
import { describePlan } from '@modules/subscriptions/plan-features';

/**
 * What the paywall says each plan gives, derived from the entitlement matrix.
 *
 * The three tiers below are the seeded matrix as it stands (prisma/seeds/
 * entitlements.ts). Several of its rows are provisional, which is the reason
 * the words come from the data: when the product owner moves a feature, the
 * paywall must follow without anybody remembering to edit it.
 */
const FREE: EntitlementMap = {
  standard_discovery: true,
  daily_swipe_limit: 50,
  daily_message_limit: 30,
  basic_filters: true,
  advanced_filters: false,
  see_who_liked_you: false,
  extend_matches: false,
  boost: false,
  rewind: false,
  max_simultaneous_modes: 3,
  show_ads: true,
};

const BASIC: EntitlementMap = {
  ...FREE,
  daily_swipe_limit: UNLIMITED,
  daily_message_limit: UNLIMITED,
  advanced_filters: true,
  rewind: true,
  max_simultaneous_modes: 5,
  show_ads: false,
};

const PREMIUM: EntitlementMap = {
  ...BASIC,
  see_who_liked_you: true,
  extend_matches: true,
  boost: true,
  max_simultaneous_modes: UNLIMITED,
};

describe('describePlan', () => {
  it('lists what Basic adds over free, in the order a person weighs it', () => {
    expect(describePlan(BASIC, FREE)).toEqual([
      'Unlimited likes',
      'Unlimited messages',
      'Filter by interests and goals',
      'Undo your last swipe',
      'Up to 5 modes at once',
      'No ads',
    ]);
  });

  it('lists what Premium adds over free', () => {
    expect(describePlan(PREMIUM, FREE)).toEqual([
      'Unlimited likes',
      'Unlimited messages',
      'See who liked you',
      'Filter by interests and goals',
      'Undo your last swipe',
      'Boost your profile',
      'Extend a match before it expires',
      'Every mode at once',
      'No ads',
    ]);
  });

  it('says nothing about what the free tier already has', () => {
    // Were rewind moved to free (open decision #10), selling it would be a lie.
    const freeWithRewind = { ...FREE, rewind: true };

    expect(describePlan(BASIC, freeWithRewind)).not.toContain('Undo your last swipe');
  });

  it('counts a raised limit, and only a raised one', () => {
    expect(describePlan({ ...FREE, daily_swipe_limit: 100 }, FREE)).toEqual(['100 likes a day']);
    expect(describePlan({ ...FREE, daily_swipe_limit: 20 }, FREE)).toEqual([]);
    expect(
      describePlan(
        { ...FREE, daily_swipe_limit: UNLIMITED },
        { ...FREE, daily_swipe_limit: UNLIMITED },
      ),
    ).toEqual([]);
  });

  it('describes the free tier against itself as nothing', () => {
    expect(describePlan(FREE, FREE)).toEqual([]);
  });
});
