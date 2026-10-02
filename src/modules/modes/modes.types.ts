export interface ModeView {
  mode: string;
  label: string;
  primary_action_label: string;
  is_enabled: boolean;
  is_primary: boolean;
  requires_verification: boolean;
  can_enable: boolean;
  min_age: number;
  max_age: number;
  radius_metres: number;
  verified_only: boolean;
  preferences: Record<string, unknown>;
  updated_at: string | null;
}

export interface ModesResponse {
  modes: ModeView[];
  enabled_count: number;
  max_simultaneous_modes: number;
  primary_mode: string | null;
}
