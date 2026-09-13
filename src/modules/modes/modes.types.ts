/** One mode as the app renders it: state, preferences, and its label. */
export interface ModeView {
  mode: string;
  label: string;
  /** spec §1: the mode changes only the label, never the action the API accepts. */
  primary_action_label: string;
  is_enabled: boolean;
  is_primary: boolean;
  requires_verification: boolean;
  /** False when the mode needs verification the user does not have. */
  can_enable: boolean;
  min_age: number;
  max_age: number;
  /** spec §4.6: metres. The client formats to miles. */
  radius_metres: number;
  verified_only: boolean;
  preferences: Record<string, unknown>;
  updated_at: string | null;
}

export interface ModesResponse {
  modes: ModeView[];
  enabled_count: number;
  /** -1 means unlimited. From the seeded entitlement matrix. */
  max_simultaneous_modes: number;
  primary_mode: string | null;
}
