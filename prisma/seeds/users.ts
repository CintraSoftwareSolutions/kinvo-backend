import {
  ChildrenPreference,
  Diet,
  EducationLevel,
  ExerciseFrequency,
  Frequency,
  Mode,
  PetSituation,
  UserStatus,
  prisma,
} from '@/db/prisma';
import { setProfileLocation, type Coordinates } from '@/db/geo';
import { hashPassword } from '@modules/auth/password.service';

/**
 * ~30 development users spread across modes and locations (spec §7, Batch 1).
 *
 * Deliberately clustered around central London with a few outliers in Manchester
 * and Edinburgh, so radius filtering visibly does something during development.
 *
 * These are NOT test fixtures. Tests seed and clean their own data (spec §0.4);
 * see tests/helpers/factories.ts.
 *
 * Every dev user shares one obvious password so the mobile team can sign in
 * against staging. Safe because these accounts only ever exist in seeded
 * development and staging databases — the seed is never run against production.
 */
export const DEV_PASSWORD = 'kinvo-dev-password';

const LONDON: Record<string, Coordinates> = {
  westminster: { longitude: -0.1276, latitude: 51.5072 },
  shoreditch: { longitude: -0.0778, latitude: 51.5265 },
  camden: { longitude: -0.1426, latitude: 51.539 },
  soho: { longitude: -0.134, latitude: 51.5137 },
  islington: { longitude: -0.103, latitude: 51.5362 },
  clapham: { longitude: -0.1382, latitude: 51.4618 },
  hackney: { longitude: -0.0553, latitude: 51.545 },
  greenwich: { longitude: -0.0098, latitude: 51.4826 },
  kensington: { longitude: -0.1919, latitude: 51.4988 },
  peckham: { longitude: -0.0693, latitude: 51.4739 },
  canary_wharf: { longitude: -0.0235, latitude: 51.5054 },
  brixton: { longitude: -0.1145, latitude: 51.4613 },
};

const ELSEWHERE: Record<string, Coordinates> = {
  manchester: { longitude: -2.2426, latitude: 53.4808 },
  edinburgh: { longitude: -3.1883, latitude: 55.9533 },
  bristol: { longitude: -2.5879, latitude: 51.4545 },
};

interface UserSeed {
  email: string;
  display_name: string;
  /** YYYY-MM-DD. Age is always computed from this (spec §5.1). */
  date_of_birth: string;
  city: string;
  coordinates: Coordinates;
  is_verified: boolean;
  bio: string;
  job_title?: string;
  organisation?: string;
  /** First entry is the primary mode. */
  modes: Mode[];
  interests: string[];
}

const USERS: UserSeed[] = [
  {
    email: 'sarah.dev@kinvo.test',
    display_name: 'Sarah',
    date_of_birth: '1999-03-14',
    city: 'Shoreditch',
    coordinates: LONDON.shoreditch!,
    is_verified: true,
    bio: 'Product designer. Will argue about typography.',
    job_title: 'Product Designer',
    organisation: 'Foundry',
    modes: [Mode.dating, Mode.networking, Mode.foodie],
    interests: ['design', 'coffee', 'film'],
  },
  {
    email: 'tom.dev@kinvo.test',
    display_name: 'Tom',
    date_of_birth: '1996-07-02',
    city: 'Camden',
    coordinates: LONDON.camden!,
    is_verified: true,
    bio: 'Half-marathon in training. Bad at rest days.',
    job_title: 'Physiotherapist',
    modes: [Mode.fitness, Mode.dating],
    interests: ['running', 'cycling', 'music'],
  },
  {
    email: 'aisha.dev@kinvo.test',
    display_name: 'Aisha',
    date_of_birth: '2001-11-23',
    city: 'Islington',
    coordinates: LONDON.islington!,
    is_verified: true,
    bio: 'Second-year medic. Looking for a library partner who actually studies.',
    modes: [Mode.study_buddy, Mode.foodie],
    interests: ['medicine', 'reading', 'coffee'],
  },
  {
    email: 'marcus.dev@kinvo.test',
    display_name: 'Marcus',
    date_of_birth: '1993-01-30',
    city: 'Canary Wharf',
    coordinates: LONDON.canary_wharf!,
    is_verified: false,
    bio: 'Markets, macro, and long walks to the coffee machine.',
    job_title: 'Analyst',
    organisation: 'Meridian Capital',
    modes: [Mode.trading, Mode.networking],
    interests: ['equities', 'index_funds', 'finance_career'],
  },
  {
    email: 'priya.dev@kinvo.test',
    display_name: 'Priya',
    date_of_birth: '1997-05-09',
    city: 'Soho',
    coordinates: LONDON.soho!,
    is_verified: true,
    bio: 'I will take you to the best dosa in London. No debate.',
    job_title: 'Chef de partie',
    modes: [Mode.foodie, Mode.dating],
    interests: ['street_food', 'baking', 'wine'],
  },
  {
    email: 'james.dev@kinvo.test',
    display_name: 'James',
    date_of_birth: '1995-09-18',
    city: 'Hackney',
    coordinates: LONDON.hackney!,
    is_verified: false,
    bio: 'Two rescue greyhounds. They pick my friends.',
    modes: [Mode.pet_dates, Mode.dating],
    interests: ['dogs', 'dog_walking', 'photography'],
  },
  {
    email: 'nina.dev@kinvo.test',
    display_name: 'Nina',
    date_of_birth: '1998-12-05',
    city: 'Clapham',
    coordinates: LONDON.clapham!,
    is_verified: true,
    bio: 'Sunday is for blankets and a very long film.',
    modes: [Mode.cuddle, Mode.dating],
    interests: ['movie_nights', 'board_games', 'meditation'],
  },
  {
    email: 'oliver.dev@kinvo.test',
    display_name: 'Oliver',
    date_of_birth: '1994-04-21',
    city: 'Kensington',
    coordinates: LONDON.kensington!,
    is_verified: true,
    bio: 'Building something small. Happy to trade notes.',
    job_title: 'Founder',
    organisation: 'Kestrel',
    modes: [Mode.networking, Mode.trading, Mode.fitness],
    interests: ['startups', 'product', 'weightlifting'],
  },
  {
    email: 'zara.dev@kinvo.test',
    display_name: 'Zara',
    date_of_birth: '2000-08-11',
    city: 'Peckham',
    coordinates: LONDON.peckham!,
    is_verified: false,
    bio: 'Climbing, mostly badly. Come fall off a wall with me.',
    modes: [Mode.fitness, Mode.dating],
    interests: ['climbing', 'yoga', 'art'],
  },
  {
    email: 'daniel.dev@kinvo.test',
    display_name: 'Daniel',
    date_of_birth: '1992-02-27',
    city: 'Greenwich',
    coordinates: LONDON.greenwich!,
    is_verified: true,
    bio: 'Law finals. Send caffeine.',
    modes: [Mode.study_buddy, Mode.networking],
    interests: ['law', 'reading', 'coffee'],
  },
  {
    email: 'leila.dev@kinvo.test',
    display_name: 'Leila',
    date_of_birth: '1999-06-16',
    city: 'Brixton',
    coordinates: LONDON.brixton!,
    is_verified: true,
    bio: 'Plant-based, mostly. Ask me about the tofu place.',
    modes: [Mode.foodie, Mode.fitness],
    interests: ['vegan_food', 'yoga', 'running'],
  },
  {
    email: 'ryan.dev@kinvo.test',
    display_name: 'Ryan',
    date_of_birth: '1991-10-08',
    city: 'Westminster',
    coordinates: LONDON.westminster!,
    is_verified: false,
    bio: 'CS masters, procrastinating professionally.',
    modes: [Mode.study_buddy, Mode.trading],
    interests: ['computer_science', 'crypto', 'gaming'],
  },
  {
    email: 'hannah.dev@kinvo.test',
    display_name: 'Hannah',
    date_of_birth: '1996-03-03',
    city: 'Shoreditch',
    coordinates: LONDON.shoreditch!,
    is_verified: true,
    bio: 'Marketing by day, pottery by night.',
    job_title: 'Marketing Lead',
    modes: [Mode.networking, Mode.dating, Mode.foodie],
    interests: ['marketing', 'art', 'wine'],
  },
  {
    email: 'kofi.dev@kinvo.test',
    display_name: 'Kofi',
    date_of_birth: '1994-11-29',
    city: 'Camden',
    coordinates: LONDON.camden!,
    is_verified: true,
    bio: 'Bench press and board games. Balanced.',
    modes: [Mode.fitness, Mode.cuddle],
    interests: ['weightlifting', 'board_games', 'music'],
  },
  {
    email: 'elena.dev@kinvo.test',
    display_name: 'Elena',
    date_of_birth: '1998-01-12',
    city: 'Islington',
    coordinates: LONDON.islington!,
    is_verified: false,
    bio: 'Learning Japanese. Very slowly.',
    modes: [Mode.study_buddy, Mode.foodie],
    interests: ['languages', 'travel', 'fine_dining'],
  },
  {
    email: 'samir.dev@kinvo.test',
    display_name: 'Samir',
    date_of_birth: '1990-07-25',
    city: 'Canary Wharf',
    coordinates: LONDON.canary_wharf!,
    is_verified: true,
    bio: 'Options, mostly. Ask me why that is a bad idea.',
    job_title: 'Trader',
    modes: [Mode.trading, Mode.networking],
    interests: ['options', 'forex', 'commodities'],
  },
  {
    email: 'grace.dev@kinvo.test',
    display_name: 'Grace',
    date_of_birth: '2002-09-04',
    city: 'Soho',
    coordinates: LONDON.soho!,
    is_verified: false,
    bio: 'Engineering student. I build things that mostly work.',
    modes: [Mode.study_buddy, Mode.fitness],
    interests: ['engineering', 'swimming', 'gaming'],
  },
  {
    email: 'noah.dev@kinvo.test',
    display_name: 'Noah',
    date_of_birth: '1993-05-19',
    city: 'Hackney',
    coordinates: LONDON.hackney!,
    is_verified: true,
    bio: 'One cat, strong opinions about coffee.',
    modes: [Mode.pet_dates, Mode.foodie],
    interests: ['cats', 'coffee', 'film'],
  },
  {
    email: 'amara.dev@kinvo.test',
    display_name: 'Amara',
    date_of_birth: '1997-12-30',
    city: 'Kensington',
    coordinates: LONDON.kensington!,
    is_verified: true,
    bio: 'Quiet evenings and a good playlist.',
    modes: [Mode.cuddle, Mode.dating],
    interests: ['music', 'movie_nights', 'meditation'],
  },
  {
    email: 'lucas.dev@kinvo.test',
    display_name: 'Lucas',
    date_of_birth: '1995-08-07',
    city: 'Clapham',
    coordinates: LONDON.clapham!,
    is_verified: false,
    bio: 'Border collie named Pixel. He runs the schedule.',
    modes: [Mode.pet_dates, Mode.fitness],
    interests: ['dogs', 'agility_training', 'running'],
  },
  {
    email: 'mei.dev@kinvo.test',
    display_name: 'Mei',
    date_of_birth: '1999-02-14',
    city: 'Greenwich',
    coordinates: LONDON.greenwich!,
    is_verified: true,
    bio: 'Photographer. I will make you stand in the cold for the light.',
    job_title: 'Photographer',
    modes: [Mode.dating, Mode.networking],
    interests: ['photography', 'travel', 'art'],
  },
  {
    email: 'ben.dev@kinvo.test',
    display_name: 'Ben',
    date_of_birth: '1988-06-11',
    city: 'Westminster',
    coordinates: LONDON.westminster!,
    is_verified: true,
    bio: 'Ten years in product. Happy to mentor.',
    job_title: 'Head of Product',
    organisation: 'Northwind',
    modes: [Mode.networking],
    interests: ['product', 'startups', 'reading'],
  },
  {
    email: 'yasmin.dev@kinvo.test',
    display_name: 'Yasmin',
    date_of_birth: '2000-04-26',
    city: 'Peckham',
    coordinates: LONDON.peckham!,
    is_verified: false,
    bio: 'Maths degree, chaos energy.',
    modes: [Mode.study_buddy, Mode.cuddle],
    interests: ['mathematics', 'board_games', 'gaming'],
  },
  {
    email: 'felix.dev@kinvo.test',
    display_name: 'Felix',
    date_of_birth: '1992-10-02',
    city: 'Brixton',
    coordinates: LONDON.brixton!,
    is_verified: true,
    bio: 'Chasing the perfect flat white since 2014.',
    modes: [Mode.foodie, Mode.dating, Mode.cuddle],
    interests: ['coffee', 'baking', 'movie_nights'],
  },
  {
    email: 'ines.dev@kinvo.test',
    display_name: 'Inès',
    date_of_birth: '1996-01-08',
    city: 'Shoreditch',
    coordinates: LONDON.shoreditch!,
    is_verified: true,
    bio: 'Yoga most mornings. Wine most evenings. Balance.',
    modes: [Mode.fitness, Mode.foodie, Mode.dating],
    interests: ['yoga', 'wine', 'travel'],
  },
  // --- Outliers. These exist so radius filtering visibly excludes people. ---
  {
    email: 'callum.dev@kinvo.test',
    display_name: 'Callum',
    date_of_birth: '1994-03-22',
    city: 'Manchester',
    coordinates: ELSEWHERE.manchester!,
    is_verified: true,
    bio: 'Northern Quarter regular.',
    modes: [Mode.dating, Mode.foodie],
    interests: ['music', 'street_food', 'film'],
  },
  {
    email: 'orla.dev@kinvo.test',
    display_name: 'Orla',
    date_of_birth: '1997-07-13',
    city: 'Manchester',
    coordinates: ELSEWHERE.manchester!,
    is_verified: false,
    bio: 'Runs by the canal, complains about the weather.',
    modes: [Mode.fitness, Mode.study_buddy],
    interests: ['running', 'languages', 'reading'],
  },
  {
    email: 'struan.dev@kinvo.test',
    display_name: 'Struan',
    date_of_birth: '1991-11-04',
    city: 'Edinburgh',
    coordinates: ELSEWHERE.edinburgh!,
    is_verified: true,
    bio: 'Hills, coffee, and a stubborn terrier.',
    modes: [Mode.pet_dates, Mode.fitness],
    interests: ['dogs', 'climbing', 'coffee'],
  },
  {
    email: 'rosa.dev@kinvo.test',
    display_name: 'Rosa',
    date_of_birth: '1998-09-27',
    city: 'Bristol',
    coordinates: ELSEWHERE.bristol!,
    is_verified: false,
    bio: 'Design student, permanently covered in paint.',
    modes: [Mode.study_buddy, Mode.dating],
    interests: ['design', 'art', 'music'],
  },
  {
    email: 'theo.dev@kinvo.test',
    display_name: 'Theo',
    date_of_birth: '1989-12-19',
    city: 'Bristol',
    coordinates: ELSEWHERE.bristol!,
    is_verified: true,
    bio: 'Index funds and early nights. Thrilling, I know.',
    job_title: 'Accountant',
    modes: [Mode.trading, Mode.cuddle],
    interests: ['index_funds', 'equities', 'movie_nights'],
  },
];

function pick<T>(values: T[], index: number): T {
  return values[index % values.length]!;
}

export async function seedUsers(): Promise<{ users: number; profiles: number }> {
  // Hashed once and reused: argon2 is deliberately slow, and hashing the same
  // string thirty times would add several seconds to every seed run.
  const passwordHash = await hashPassword(DEV_PASSWORD);

  const interestRecords = await prisma.interest.findMany();
  const interestsBySlug = new Map(interestRecords.map((i) => [i.slug, i.id]));

  const drinkingOptions = [Frequency.socially, Frequency.rarely, Frequency.never];
  const smokingOptions = [Frequency.never, Frequency.rarely, Frequency.socially];
  const exerciseOptions = [
    ExerciseFrequency.often,
    ExerciseFrequency.sometimes,
    ExerciseFrequency.daily,
  ];
  const dietOptions = [Diet.omnivore, Diet.vegetarian, Diet.vegan, Diet.pescatarian];
  const petOptions = [PetSituation.none, PetSituation.dog, PetSituation.cat];
  const childrenOptions = [
    ChildrenPreference.none,
    ChildrenPreference.open,
    ChildrenPreference.want_children,
  ];
  const educationOptions = [
    EducationLevel.undergraduate,
    EducationLevel.postgraduate,
    EducationLevel.other,
  ];

  for (const [index, seed] of USERS.entries()) {
    const existingIdentity = await prisma.authIdentity.findUnique({
      where: { provider_identifier: { provider: 'email', identifier: seed.email } },
      select: { id: true, user_id: true },
    });

    if (existingIdentity) {
      // Re-seeding an older database: these rows predate password hashing.
      await prisma.authIdentity.update({
        where: { id: existingIdentity.id },
        data: { password_hash: passwordHash },
      });
    }

    const user = existingIdentity
      ? await prisma.user.update({
          where: { id: existingIdentity.user_id },
          data: {
            display_name: seed.display_name,
            date_of_birth: new Date(`${seed.date_of_birth}T00:00:00Z`),
            is_verified: seed.is_verified,
            status: UserStatus.active,
            onboarded_at: new Date(),
          },
        })
      : await prisma.user.create({
          data: {
            display_name: seed.display_name,
            date_of_birth: new Date(`${seed.date_of_birth}T00:00:00Z`),
            is_verified: seed.is_verified,
            status: UserStatus.active,
            onboarded_at: new Date(),
            auth_identities: {
              create: {
                provider: 'email',
                identifier: seed.email,
                password_hash: passwordHash,
                verified_at: new Date(),
              },
            },
          },
        });

    const profile = await prisma.profile.upsert({
      where: { user_id: user.id },
      create: {
        user_id: user.id,
        bio: seed.bio,
        job_title: seed.job_title ?? null,
        organisation: seed.organisation ?? null,
        education: pick(educationOptions, index),
        city: seed.city,
        country: 'GB',
        drinking: pick(drinkingOptions, index),
        smoking: pick(smokingOptions, index),
        exercise: pick(exerciseOptions, index),
        diet: pick(dietOptions, index),
        pets: pick(petOptions, index),
        children: pick(childrenOptions, index),
        completion_percentage: 80,
      },
      update: { bio: seed.bio, city: seed.city },
    });

    // Prisma cannot write a geography column — see src/db/geo.ts.
    await setProfileLocation(profile.id, seed.coordinates);

    for (const [modeIndex, mode] of seed.modes.entries()) {
      await prisma.userMode.upsert({
        where: { user_id_mode: { user_id: user.id, mode } },
        create: {
          user_id: user.id,
          mode,
          is_enabled: true,
          is_primary: modeIndex === 0,
          radius_metres: mode === Mode.cuddle ? 8000 : 48280,
        },
        update: { is_enabled: true, is_primary: modeIndex === 0 },
      });
    }

    for (const slug of seed.interests) {
      const interestId = interestsBySlug.get(slug);
      if (!interestId) continue;

      await prisma.profileInterest.upsert({
        where: { profile_id_interest_id: { profile_id: profile.id, interest_id: interestId } },
        create: { profile_id: profile.id, interest_id: interestId },
        update: {},
      });
    }
  }

  return { users: USERS.length, profiles: USERS.length };
}
