import type { UserCompact } from '@utils/compact';

/** What a profile owner sees about themselves. */
export interface OwnProfile {
  id: string;
  user_id: string;
  display_name: string;
  date_of_birth: string | null;
  age: number | null;
  bio: string | null;
  job_title: string | null;
  organisation: string | null;
  education: string | null;
  height_cm: number | null;
  city: string | null;
  country: string | null;
  location: { longitude: number; latitude: number } | null;
  location_updated_at: string | null;
  drinking: string | null;
  smoking: string | null;
  exercise: string | null;
  diet: string | null;
  pets: string | null;
  children: string | null;
  interests: ProfileInterestItem[];
  prompts: ProfilePromptItem[];
  completion_percentage: number;
  is_verified: boolean;
  status: string;
  is_onboarded: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * What anyone else sees. Deliberately a different type from OwnProfile so a
 * field cannot leak by being added to a shared interface — the compiler forces
 * a decision about visibility for every new column.
 */
export interface PublicProfile {
  user: UserCompact;
  bio: string | null;
  job_title: string | null;
  organisation: string | null;
  education: string | null;
  height_cm: number | null;
  city: string | null;
  /** Metres (spec §4.6). Null when either party has no location. */
  distance_metres: number | null;
  drinking: string | null;
  smoking: string | null;
  exercise: string | null;
  diet: string | null;
  pets: string | null;
  children: string | null;
  interests: ProfileInterestItem[];
  prompts: ProfilePromptItem[];
}

export interface ProfileInterestItem {
  id: string;
  slug: string;
  label: string;
  category: string;
}

export interface ProfilePromptItem {
  question_id: string;
  slug: string;
  question: string;
  answer: string;
  position: number;
}

export interface CompletionCriterion {
  key: string;
  label: string;
  weight: number;
  is_met: boolean;
}

export interface ProfileCompletion {
  percentage: number;
  criteria: CompletionCriterion[];
}
