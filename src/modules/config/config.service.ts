import { Mode, prisma } from '@/db/prisma';
import { PAGINATION } from '@config/constants';

/**
 * GET /config (spec §4.12).
 *
 * "Serves mode lists, report reasons, interest tags, and prompt questions so
 * adding a mode does not require an app release."
 *
 * The deck action labels are the important part. spec §1 fixes the API actions
 * at pass / like / super_like for every mode, and the mode only changes the
 * word the app renders on the button. Shipping those words from here is what
 * keeps that true — the alternative is a switch statement in the Flutter app
 * that has to be updated and re-released whenever a mode is added or renamed.
 */

interface ModeConfig {
  value: Mode;
  label: string;
  /** What the app prints on the primary (like) button for this mode. */
  primary_action_label: string;
  /** Secondary flavour text some screens use for the super-like action. */
  super_action_label: string;
  description: string;
}

/** From the Mode Selector screen in spec §1. */
const MODES: ModeConfig[] = [
  {
    value: Mode.dating,
    label: 'Dating',
    primary_action_label: 'Like',
    super_action_label: 'Super Like',
    description: 'Meet someone new.',
  },
  {
    value: Mode.study_buddy,
    label: 'Study Buddy',
    primary_action_label: 'Study',
    super_action_label: 'Invite',
    description: 'Find someone to study with.',
  },
  {
    value: Mode.networking,
    label: 'Networking',
    primary_action_label: 'Connect',
    super_action_label: 'Intro',
    description: 'Grow your professional circle.',
  },
  {
    value: Mode.trading,
    label: 'Trading',
    primary_action_label: 'Trade',
    super_action_label: 'Signal',
    // spec §1: an interest category and nothing more. Kinvo facilitates no
    // trades, transfers, brokerage, portfolio tracking, or asset custody.
    description: 'Talk markets with people who share the interest.',
  },
  {
    value: Mode.foodie,
    label: 'Foodie',
    primary_action_label: 'Taste',
    super_action_label: 'Table',
    description: 'Find someone to eat well with.',
  },
  {
    value: Mode.cuddle,
    label: 'Cuddle',
    primary_action_label: 'Cozy',
    super_action_label: 'Warmth',
    description: 'Low-key company and comfort.',
  },
  {
    value: Mode.pet_dates,
    label: 'Pet Dates',
    primary_action_label: 'Paw',
    super_action_label: 'Playdate',
    description: 'Playdates for you and your pet.',
  },
  {
    value: Mode.fitness,
    label: 'Fitness',
    primary_action_label: 'Fitness',
    super_action_label: 'Train',
    description: 'Find a training partner.',
  },
];

/** spec §5.7. */
const REPORT_REASONS = [
  { value: 'harassment', label: 'Harassment or abuse' },
  { value: 'fake_profile', label: 'Fake profile' },
  { value: 'spam_scam', label: 'Spam or scam' },
  { value: 'safety_concern', label: 'Safety concern' },
];

const VENUE_CATEGORIES = [
  { value: 'cafe', label: 'Café' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'park', label: 'Park' },
  { value: 'gym', label: 'Gym' },
  { value: 'study_spot', label: 'Study spot' },
  { value: 'pet_friendly', label: 'Pet friendly' },
  { value: 'romantic', label: 'Romantic' },
  { value: 'health_conscious', label: 'Health conscious' },
];

const LIFESTYLE_OPTIONS = {
  drinking: ['never', 'rarely', 'socially', 'regularly', 'prefer_not_to_say'],
  smoking: ['never', 'rarely', 'socially', 'regularly', 'prefer_not_to_say'],
  exercise: ['never', 'sometimes', 'often', 'daily', 'prefer_not_to_say'],
  diet: [
    'omnivore',
    'vegetarian',
    'vegan',
    'pescatarian',
    'halal',
    'kosher',
    'other',
    'prefer_not_to_say',
  ],
  pets: ['none', 'dog', 'cat', 'other', 'multiple', 'prefer_not_to_say'],
  children: [
    'none',
    'have_children',
    'want_children',
    'do_not_want_children',
    'open',
    'prefer_not_to_say',
  ],
  education: [
    'high_school',
    'undergraduate',
    'postgraduate',
    'doctorate',
    'other',
    'prefer_not_to_say',
  ],
};

export interface AppConfig {
  modes: ModeConfig[];
  deck_actions: string[];
  interests: { id: string; slug: string; label: string; category: string; modes: string[] }[];
  prompts: { id: string; slug: string; question: string; modes: string[] }[];
  report_reasons: { value: string; label: string }[];
  venue_categories: { value: string; label: string }[];
  lifestyle_options: typeof LIFESTYLE_OPTIONS;
  limits: {
    max_interests: number;
    max_prompts: number;
    max_photos: number;
    bio_max_length: number;
    default_page_size: number;
    max_page_size: number;
  };
}

export async function getAppConfig(): Promise<AppConfig> {
  const [interests, prompts] = await Promise.all([
    prisma.interest.findMany({
      where: { is_active: true },
      orderBy: [{ category: 'asc' }, { sort_order: 'asc' }],
      select: { id: true, slug: true, label: true, category: true, modes: true },
    }),
    prisma.promptQuestion.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' },
      select: { id: true, slug: true, question: true, modes: true },
    }),
  ]);

  return {
    modes: MODES,
    // spec §1: fixed for every mode. Never per-mode action enums.
    deck_actions: ['pass', 'like', 'super_like'],
    interests,
    prompts,
    report_reasons: REPORT_REASONS,
    venue_categories: VENUE_CATEGORIES,
    lifestyle_options: LIFESTYLE_OPTIONS,
    limits: {
      max_interests: 10,
      max_prompts: 3,
      // spec §7 Batch 4. Declared now so the client can build the grid.
      max_photos: 6,
      bio_max_length: 500,
      default_page_size: PAGINATION.DEFAULT_LIMIT,
      max_page_size: PAGINATION.MAX_LIMIT,
    },
  };
}
