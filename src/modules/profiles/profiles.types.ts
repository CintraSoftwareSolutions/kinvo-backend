import type { PublicPhotoView } from '@modules/media/photos.service';
import type { UserCompact } from '@utils/compact';

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
  completion_missing: { key: string; label: string }[];
  is_verified: boolean;
  status: string;
  is_onboarded: boolean;
  created_at: string;
  updated_at: string;
}

export interface PublicProfile {
  user: UserCompact;
  photos: PublicPhotoView[];
  bio: string | null;
  job_title: string | null;
  organisation: string | null;
  education: string | null;
  height_cm: number | null;
  city: string | null;
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
