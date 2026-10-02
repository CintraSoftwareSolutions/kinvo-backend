import type { UserRole, UserStatus } from '@/db/prisma';

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface AccessTokenPayload {
  sub: string;
  did?: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  fam: string;
  type: 'refresh';
}

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  status: UserStatus;
  is_onboarded: boolean;
}

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
