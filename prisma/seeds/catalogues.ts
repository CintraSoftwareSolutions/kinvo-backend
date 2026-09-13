import { Mode, prisma } from '@/db/prisma';

/**
 * Catalogue data served by GET /config (spec §4.12), so adding an interest or a
 * prompt question never requires an app release.
 *
 * Idempotent: every write is an upsert keyed on `slug`, so re-running the seed
 * updates rather than duplicates.
 */

interface InterestSeed {
  slug: string;
  label: string;
  category: string;
  modes: Mode[];
}

const ALL_MODES: Mode[] = [
  Mode.dating,
  Mode.study_buddy,
  Mode.networking,
  Mode.trading,
  Mode.foodie,
  Mode.cuddle,
  Mode.pet_dates,
  Mode.fitness,
];

const INTERESTS: InterestSeed[] = [
  // General — surfaced in every mode.
  { slug: 'music', label: 'Music', category: 'general', modes: ALL_MODES },
  { slug: 'travel', label: 'Travel', category: 'general', modes: ALL_MODES },
  { slug: 'film', label: 'Film & TV', category: 'general', modes: ALL_MODES },
  { slug: 'reading', label: 'Reading', category: 'general', modes: ALL_MODES },
  { slug: 'gaming', label: 'Gaming', category: 'general', modes: ALL_MODES },
  { slug: 'art', label: 'Art', category: 'general', modes: ALL_MODES },
  { slug: 'photography', label: 'Photography', category: 'general', modes: ALL_MODES },

  // Fitness
  { slug: 'running', label: 'Running', category: 'fitness', modes: [Mode.fitness, Mode.dating] },
  { slug: 'weightlifting', label: 'Weightlifting', category: 'fitness', modes: [Mode.fitness] },
  { slug: 'yoga', label: 'Yoga', category: 'fitness', modes: [Mode.fitness, Mode.cuddle] },
  { slug: 'cycling', label: 'Cycling', category: 'fitness', modes: [Mode.fitness] },
  { slug: 'climbing', label: 'Climbing', category: 'fitness', modes: [Mode.fitness] },
  { slug: 'swimming', label: 'Swimming', category: 'fitness', modes: [Mode.fitness] },

  // Foodie
  { slug: 'coffee', label: 'Coffee', category: 'food', modes: [Mode.foodie, Mode.dating] },
  { slug: 'baking', label: 'Baking', category: 'food', modes: [Mode.foodie] },
  { slug: 'street_food', label: 'Street food', category: 'food', modes: [Mode.foodie] },
  {
    slug: 'fine_dining',
    label: 'Fine dining',
    category: 'food',
    modes: [Mode.foodie, Mode.dating],
  },
  { slug: 'vegan_food', label: 'Vegan food', category: 'food', modes: [Mode.foodie] },
  { slug: 'wine', label: 'Wine', category: 'food', modes: [Mode.foodie, Mode.dating] },

  // Study Buddy
  { slug: 'mathematics', label: 'Mathematics', category: 'subject', modes: [Mode.study_buddy] },
  {
    slug: 'computer_science',
    label: 'Computer science',
    category: 'subject',
    modes: [Mode.study_buddy, Mode.networking],
  },
  { slug: 'medicine', label: 'Medicine', category: 'subject', modes: [Mode.study_buddy] },
  { slug: 'law', label: 'Law', category: 'subject', modes: [Mode.study_buddy, Mode.networking] },
  { slug: 'languages', label: 'Languages', category: 'subject', modes: [Mode.study_buddy] },
  {
    slug: 'engineering',
    label: 'Engineering',
    category: 'subject',
    modes: [Mode.study_buddy, Mode.networking],
  },

  // Networking
  { slug: 'startups', label: 'Startups', category: 'professional', modes: [Mode.networking] },
  { slug: 'design', label: 'Design', category: 'professional', modes: [Mode.networking] },
  { slug: 'marketing', label: 'Marketing', category: 'professional', modes: [Mode.networking] },
  { slug: 'product', label: 'Product', category: 'professional', modes: [Mode.networking] },
  { slug: 'finance_career', label: 'Finance', category: 'professional', modes: [Mode.networking] },

  // Trading — spec §1: these are interest tags and nothing more. Nothing in the
  // platform quotes, brokers, or settles any of them.
  { slug: 'equities', label: 'Equities', category: 'trading_interest', modes: [Mode.trading] },
  { slug: 'crypto', label: 'Crypto', category: 'trading_interest', modes: [Mode.trading] },
  { slug: 'forex', label: 'Forex', category: 'trading_interest', modes: [Mode.trading] },
  {
    slug: 'commodities',
    label: 'Commodities',
    category: 'trading_interest',
    modes: [Mode.trading],
  },
  { slug: 'options', label: 'Options', category: 'trading_interest', modes: [Mode.trading] },
  {
    slug: 'index_funds',
    label: 'Index funds',
    category: 'trading_interest',
    modes: [Mode.trading],
  },

  // Pet Dates
  { slug: 'dogs', label: 'Dogs', category: 'pets', modes: [Mode.pet_dates] },
  { slug: 'cats', label: 'Cats', category: 'pets', modes: [Mode.pet_dates] },
  {
    slug: 'dog_walking',
    label: 'Dog walking',
    category: 'pets',
    modes: [Mode.pet_dates, Mode.fitness],
  },
  {
    slug: 'agility_training',
    label: 'Agility training',
    category: 'pets',
    modes: [Mode.pet_dates],
  },

  // Cuddle
  {
    slug: 'movie_nights',
    label: 'Movie nights',
    category: 'comfort',
    modes: [Mode.cuddle, Mode.dating],
  },
  {
    slug: 'board_games',
    label: 'Board games',
    category: 'comfort',
    modes: [Mode.cuddle, Mode.dating],
  },
  {
    slug: 'meditation',
    label: 'Meditation',
    category: 'comfort',
    modes: [Mode.cuddle, Mode.fitness],
  },
];

interface PromptSeed {
  slug: string;
  question: string;
  modes: Mode[];
}

const PROMPTS: PromptSeed[] = [
  { slug: 'weekend_looks_like', question: 'A perfect weekend looks like…', modes: ALL_MODES },
  { slug: 'talk_for_hours', question: 'I could talk for hours about…', modes: ALL_MODES },
  { slug: 'never_shut_up', question: "I'll never shut up about…", modes: ALL_MODES },
  { slug: 'looking_for', question: "What I'm looking for is…", modes: [Mode.dating, Mode.cuddle] },
  { slug: 'studying_for', question: "I'm currently studying…", modes: [Mode.study_buddy] },
  { slug: 'study_style', question: 'My study style is…', modes: [Mode.study_buddy] },
  {
    slug: 'working_on',
    question: "I'm currently working on…",
    modes: [Mode.networking, Mode.trading],
  },
  { slug: 'help_others_with', question: 'I can help other people with…', modes: [Mode.networking] },
  { slug: 'best_meal', question: 'The best meal I ever had was…', modes: [Mode.foodie] },
  { slug: 'go_to_order', question: 'My go-to order is…', modes: [Mode.foodie] },
  { slug: 'my_pet', question: 'My pet is best described as…', modes: [Mode.pet_dates] },
  { slug: 'training_for', question: "I'm training for…", modes: [Mode.fitness] },
  { slug: 'comfort_show', question: 'My comfort show is…', modes: [Mode.cuddle] },
];

export async function seedCatalogues(): Promise<{ interests: number; prompts: number }> {
  for (const interest of INTERESTS) {
    await prisma.interest.upsert({
      where: { slug: interest.slug },
      create: {
        slug: interest.slug,
        label: interest.label,
        category: interest.category,
        modes: interest.modes,
        sort_order: INTERESTS.indexOf(interest),
      },
      update: {
        label: interest.label,
        category: interest.category,
        modes: interest.modes,
        is_active: true,
      },
    });
  }

  for (const prompt of PROMPTS) {
    await prisma.promptQuestion.upsert({
      where: { slug: prompt.slug },
      create: {
        slug: prompt.slug,
        question: prompt.question,
        modes: prompt.modes,
        sort_order: PROMPTS.indexOf(prompt),
      },
      update: { question: prompt.question, modes: prompt.modes, is_active: true },
    });
  }

  return { interests: INTERESTS.length, prompts: PROMPTS.length };
}
