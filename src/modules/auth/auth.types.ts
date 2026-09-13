import type { UserRole, UserStatus } from '@/db/prisma';

/** spec §4.3: the exact shape every auth endpoint returns. */
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  /** This token's own id — the row it maps to in refresh_tokens. */
  jti: string;
  /** The family it belongs to. Replay revokes every token sharing this. */
  fam: string;
  type: 'refresh';
}

/** Attached to the request by the authenticate middleware. */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  status: UserStatus;
  is_onboarded: boolean;
}

/** The `data` payload of GET /auth/me. */
export interface AuthMeResponse {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  age: number | null;
  status: UserStatus;
  role: UserRole;
  is_verified: boolean;
  is_onboarded: boolean;
  subscription_tier: string;
  identities: {
    provider: string;
    identifier: string;
    is_verified: boolean;
  }[];
  created_at: string;
}
