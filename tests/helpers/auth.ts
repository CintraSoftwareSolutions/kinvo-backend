import { API_PREFIX } from '@config/constants';
import { UserStatus, prisma } from '@/db/prisma';
import { issueTokenPair } from '@modules/auth/token.service';
import { hashPassword } from '@modules/auth/password.service';
import type { AuthTokens } from '@modules/auth/auth.types';
import { adultDateOfBirth, uniqueEmail } from './factories';

/**
 * Sign-in helpers.
 *
 * Every batch from here on needs an authenticated request, so this is the one
 * place that knows how to make one. Later suites should call
 * `createAuthenticatedUser` and `authHeader` rather than posting to /auth/login
 * — a login failure in an unrelated suite should not read as a failure of the
 * feature under test.
 */

export const AUTH_BASE = `${API_PREFIX}/auth`;

export const TEST_PASSWORD = 'correct horse battery staple';

export interface AuthenticatedFixture {
  user_id: string;
  email: string;
  tokens: AuthTokens;
}

export interface CreateAuthenticatedOptions {
  email?: string;
  password?: string;
  display_name?: string;
  status?: UserStatus;
  /** Defaults true: most tests want a user who can actually use the product. */
  onboarded?: boolean;
  is_verified?: boolean;
  role?: 'user' | 'moderator' | 'admin';
  date_of_birth?: Date | null;
}

/**
 * Creates a user with an email identity and returns a usable token pair.
 * Bypasses the HTTP layer deliberately — see the note above.
 */
export async function createAuthenticatedUser(
  options: CreateAuthenticatedOptions = {},
): Promise<AuthenticatedFixture> {
  const email = options.email ?? uniqueEmail();
  const onboarded = options.onboarded ?? true;

  const user = await prisma.user.create({
    data: {
      display_name: options.display_name ?? 'Test User',
      date_of_birth:
        options.date_of_birth === undefined ? adultDateOfBirth() : options.date_of_birth,
      status: options.status ?? UserStatus.active,
      role: options.role ?? 'user',
      is_verified: options.is_verified ?? false,
      onboarded_at: onboarded ? new Date() : null,
      auth_identities: {
        create: {
          provider: 'email',
          identifier: email.toLowerCase(),
          password_hash: await hashPassword(options.password ?? TEST_PASSWORD),
          verified_at: new Date(),
        },
      },
    },
    select: { id: true },
  });

  const tokens = await issueTokenPair(user.id);

  return { user_id: user.id, email: email.toLowerCase(), tokens };
}

export function authHeader(tokens: AuthTokens): { Authorization: string } {
  return { Authorization: `Bearer ${tokens.access_token}` };
}

export function bearer(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}
