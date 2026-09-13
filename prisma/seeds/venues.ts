import { Mode, VenueCategory, prisma } from '@/db/prisma';
import { setVenueLocation, type Coordinates } from '@/db/geo';

/**
 * Admin-curated venues (spec §5.9). Suggestions are tuned to the match's shared
 * mode, which is what the `modes` array drives.
 *
 * Locations are real London coordinates so radius and distance-sort behaviour
 * can be exercised by hand during development. Business names are invented;
 * public parks use their real names.
 *
 * Coordinates go in through raw SQL (src/db/geo.ts) because Prisma cannot write
 * a geography column.
 */

interface VenueSeed {
  name: string;
  category: VenueCategory;
  description: string;
  coordinates: Coordinates;
  address: string;
  city: string;
  rating: number;
  price_level: number | null;
  modes: Mode[];
}

const VENUES: VenueSeed[] = [
  {
    name: 'Kiln & Kettle',
    category: VenueCategory.cafe,
    description: 'Small-batch roaster with long tables and reliable power sockets.',
    coordinates: { longitude: -0.0778, latitude: 51.5265 },
    address: '12 Rivington Street, Shoreditch',
    city: 'London',
    rating: 4.6,
    price_level: 2,
    modes: [Mode.dating, Mode.study_buddy, Mode.networking, Mode.foodie, Mode.trading],
  },
  {
    name: 'The Reading Room',
    category: VenueCategory.study_spot,
    description: 'Quiet floor, free refills, no time limit on a table.',
    coordinates: { longitude: -0.103, latitude: 51.5362 },
    address: '48 Upper Street, Islington',
    city: 'London',
    rating: 4.8,
    price_level: 1,
    modes: [Mode.study_buddy],
  },
  {
    name: 'Copper Lane Coffee',
    category: VenueCategory.cafe,
    description: 'Corner café with pavement seating and a very tolerant dog policy.',
    coordinates: { longitude: -0.1426, latitude: 51.539 },
    address: '3 Inverness Street, Camden',
    city: 'London',
    rating: 4.4,
    price_level: 1,
    modes: [Mode.dating, Mode.foodie, Mode.pet_dates],
  },
  {
    name: 'Saltwater',
    category: VenueCategory.restaurant,
    description: 'Coastal small plates, open kitchen, counter seats for two.',
    coordinates: { longitude: -0.134, latitude: 51.5137 },
    address: '61 Dean Street, Soho',
    city: 'London',
    rating: 4.7,
    price_level: 3,
    modes: [Mode.dating, Mode.foodie],
  },
  {
    name: 'Ember Room',
    category: VenueCategory.romantic,
    description: 'Low light, small tables, a wine list longer than the menu.',
    coordinates: { longitude: -0.1919, latitude: 51.4988 },
    address: '22 Kensington Church Street',
    city: 'London',
    rating: 4.9,
    price_level: 4,
    modes: [Mode.dating, Mode.cuddle],
  },
  {
    name: 'Hyde Park',
    category: VenueCategory.park,
    description: 'Central, open, and easy to leave — a sensible first meeting.',
    coordinates: { longitude: -0.1657, latitude: 51.5073 },
    address: 'Hyde Park',
    city: 'London',
    rating: 4.8,
    price_level: null,
    modes: [Mode.dating, Mode.pet_dates, Mode.fitness, Mode.cuddle],
  },
  {
    name: "Regent's Park",
    category: VenueCategory.park,
    description: 'Wide paths, running loops, and a boating lake.',
    coordinates: { longitude: -0.156, latitude: 51.5313 },
    address: "Regent's Park",
    city: 'London',
    rating: 4.8,
    price_level: null,
    modes: [Mode.dating, Mode.pet_dates, Mode.fitness],
  },
  {
    name: 'Hampstead Heath',
    category: VenueCategory.pet_friendly,
    description: 'Off-lead space, swimming ponds, and a lot of very happy dogs.',
    coordinates: { longitude: -0.1608, latitude: 51.5608 },
    address: 'Hampstead Heath',
    city: 'London',
    rating: 4.9,
    price_level: null,
    modes: [Mode.pet_dates, Mode.fitness, Mode.dating],
  },
  {
    name: 'Battersea Park',
    category: VenueCategory.pet_friendly,
    description: 'Riverside paths and a fenced dog run.',
    coordinates: { longitude: -0.156, latitude: 51.4791 },
    address: 'Battersea Park',
    city: 'London',
    rating: 4.6,
    price_level: null,
    modes: [Mode.pet_dates, Mode.fitness],
  },
  {
    name: 'Ironworks Gym',
    category: VenueCategory.gym,
    description: 'Platforms, chalk allowed, day passes for guests.',
    coordinates: { longitude: -0.0553, latitude: 51.545 },
    address: '9 Mare Street, Hackney',
    city: 'London',
    rating: 4.5,
    price_level: 2,
    modes: [Mode.fitness],
  },
  {
    name: 'Vertical Climbing Centre',
    category: VenueCategory.gym,
    description: 'Bouldering walls and a café that stays open late.',
    coordinates: { longitude: -0.0693, latitude: 51.4739 },
    address: '140 Rye Lane, Peckham',
    city: 'London',
    rating: 4.7,
    price_level: 2,
    modes: [Mode.fitness, Mode.dating],
  },
  {
    name: 'Green & Grain',
    category: VenueCategory.health_conscious,
    description: 'Grain bowls, cold press, macros printed on the menu.',
    coordinates: { longitude: -0.1382, latitude: 51.4618 },
    address: '77 Clapham High Street',
    city: 'London',
    rating: 4.3,
    price_level: 2,
    modes: [Mode.fitness, Mode.foodie],
  },
  {
    name: 'The Sunflower Kitchen',
    category: VenueCategory.health_conscious,
    description: 'Entirely plant-based, counter service, quick.',
    coordinates: { longitude: -0.1145, latitude: 51.4613 },
    address: '18 Atlantic Road, Brixton',
    city: 'London',
    rating: 4.5,
    price_level: 2,
    modes: [Mode.fitness, Mode.foodie],
  },
  {
    name: 'Wharf & Co.',
    category: VenueCategory.cafe,
    description: 'Business-district café with bookable meeting booths.',
    coordinates: { longitude: -0.0235, latitude: 51.5054 },
    address: '1 Canada Square, Canary Wharf',
    city: 'London',
    rating: 4.2,
    price_level: 3,
    modes: [Mode.networking, Mode.trading],
  },
  {
    name: 'The Exchange',
    category: VenueCategory.restaurant,
    description: 'Long bar, loud room, popular after work.',
    coordinates: { longitude: -0.0886, latitude: 51.5155 },
    address: '30 Threadneedle Street, City of London',
    city: 'London',
    rating: 4.1,
    price_level: 3,
    modes: [Mode.networking, Mode.trading],
  },
  {
    name: 'Greenwich Park',
    category: VenueCategory.park,
    description: 'Hill views over the river, plenty of space to walk and talk.',
    coordinates: { longitude: -0.0098, latitude: 51.4826 },
    address: 'Greenwich Park',
    city: 'London',
    rating: 4.8,
    price_level: null,
    modes: [Mode.dating, Mode.pet_dates, Mode.fitness],
  },
  {
    name: 'Richmond Park',
    category: VenueCategory.park,
    description: 'Deer, long trails, and genuine quiet.',
    coordinates: { longitude: -0.273, latitude: 51.4425 },
    address: 'Richmond Park',
    city: 'London',
    rating: 4.9,
    price_level: null,
    modes: [Mode.pet_dates, Mode.fitness, Mode.cuddle],
  },
  {
    name: 'Notting Hill Bookshop Café',
    category: VenueCategory.study_spot,
    description: 'Books downstairs, tables upstairs, nobody rushes you.',
    coordinates: { longitude: -0.2058, latitude: 51.509 },
    address: '13 Blenheim Crescent, Notting Hill',
    city: 'London',
    rating: 4.6,
    price_level: 2,
    modes: [Mode.study_buddy, Mode.dating],
  },
  {
    name: 'Lantern',
    category: VenueCategory.romantic,
    description: 'Candlelit, twelve tables, booking essential.',
    coordinates: { longitude: -0.1276, latitude: 51.5072 },
    address: '5 Great Smith Street, Westminster',
    city: 'London',
    rating: 4.8,
    price_level: 4,
    modes: [Mode.dating, Mode.cuddle],
  },
  {
    name: 'Northern Quarter Coffee',
    category: VenueCategory.cafe,
    description: 'Manchester outpost — deliberately far from London for testing.',
    coordinates: { longitude: -2.2426, latitude: 53.4808 },
    address: '4 Thomas Street, Manchester',
    city: 'Manchester',
    rating: 4.5,
    price_level: 2,
    modes: [Mode.dating, Mode.foodie, Mode.study_buddy],
  },
];

export async function seedVenues(): Promise<{ venues: number }> {
  for (const venue of VENUES) {
    const existing = await prisma.venue.findFirst({ where: { name: venue.name } });

    const record = existing
      ? await prisma.venue.update({
          where: { id: existing.id },
          data: {
            category: venue.category,
            description: venue.description,
            address: venue.address,
            city: venue.city,
            country: 'GB',
            rating: venue.rating,
            price_level: venue.price_level,
            modes: venue.modes,
            is_active: true,
          },
        })
      : await prisma.venue.create({
          data: {
            name: venue.name,
            category: venue.category,
            description: venue.description,
            address: venue.address,
            city: venue.city,
            country: 'GB',
            rating: venue.rating,
            price_level: venue.price_level,
            modes: venue.modes,
          },
        });

    await setVenueLocation(record.id, venue.coordinates);
  }

  return { venues: VENUES.length };
}
