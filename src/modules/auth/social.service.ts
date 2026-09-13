import { type AuthProvider, UserStatus, prisma } from '@/db/prisma';
import { verifyAppleIdToken } from '@/providers/apple-auth.provider';
import { type SocialIdentity, verifyGoogleIdToken } from '@/providers/google-auth.provider';
import { logger } from '@utils/logger';

/**
 * Google and Apple sign-in (spec §5.1, §7 Batch 2).
 *
 * The rule that matters: signing up with email and later using Google on the
 * same address LINKS to the existing user. It never creates a second account.
 * One user, many AuthIdentity rows.
 */

export interface SocialSignInResult {
  user_id: string;
  /** True when this call created the account, so the caller can log it. */
  is_new_user: boolean;
}

/**
 * A verified email is the only safe basis for linking.
 *
 * If an unverified address could link, anyone could create a provider account
 * claiming victim@example.com and be handed the victim's Kinvo account. Google
 * and Apple both report verification status; we require it.
 */
function canLinkByEmail(identity: SocialIdentity): identity is SocialIdentity & { email: string } {
  return Boolean(identity.email) && identity.email_verified;
}

function fallbackDisplayName(identity: SocialIdentity, requested?: string): string {
  const candidate = requested?.trim() || identity.name?.trim();
  if (candidate) {
    return candidate.slice(0, 50);
  }

  // Apple hides the name after first authorisation and may relay a private
  // address, so a local-part fallback is often all there is.
  const localPart = identity.email?.split('@')[0];
  return (localPart || 'New user').slice(0, 50);
}

async function resolveIdentity(
  provider: AuthProvider,
  identity: SocialIdentity,
  requestedDisplayName?: string,
): Promise<SocialSignInResult> {
  // 1. Seen this provider account before.
  const existing = await prisma.authIdentity.findUnique({
    where: { provider_identifier: { provider, identifier: identity.subject } },
    select: { user_id: true },
  });

  if (existing) {
    return { user_id: existing.user_id, is_new_user: false };
  }

  // 2. Same verified email as an account already here — link, never duplicate.
  if (canLinkByEmail(identity)) {
    const byEmail = await prisma.authIdentity.findUnique({
      where: { provider_identifier: { provider: 'email', identifier: identity.email } },
      select: { user_id: true },
    });

    if (byEmail) {
      await prisma.authIdentity.create({
        data: {
          user_id: byEmail.user_id,
          provider,
          identifier: identity.subject,
          verified_at: new Date(),
        },
      });

      logger.info(
        { user_id: byEmail.user_id, provider },
        'linked social identity to existing user',
      );
      return { user_id: byEmail.user_id, is_new_user: false };
    }
  }

  // 3. Genuinely new.
  //
  // No date of birth: neither Google nor Apple supplies one. The account is
  // created `pending`, which blocks discovery, matching, and chat with
  // ONBOARDING_INCOMPLETE until Batch 3's onboarding collects a date of birth
  // and applies the under-18 rejection (spec §5.1).
  const user = await prisma.user.create({
    data: {
      display_name: fallbackDisplayName(identity, requestedDisplayName),
      date_of_birth: null,
      status: UserStatus.pending,
      auth_identities: {
        create: {
          provider,
          identifier: identity.subject,
          verified_at: new Date(),
        },
      },
    },
    select: { id: true },
  });

  // Record the verified address too, so a later email registration or a
  // different provider on the same address links rather than duplicating.
  if (canLinkByEmail(identity)) {
    const emailTaken = await prisma.authIdentity.findUnique({
      where: { provider_identifier: { provider: 'email', identifier: identity.email } },
      select: { id: true },
    });

    if (!emailTaken) {
      await prisma.authIdentity.create({
        data: {
          user_id: user.id,
          provider: 'email',
          identifier: identity.email,
          // No password_hash: this identity exists to enable linking, not
          // password sign-in. Forgot-password can set one later.
          verified_at: new Date(),
        },
      });
    }
  }

  return { user_id: user.id, is_new_user: true };
}

export async function signInWithGoogle(
  idToken: string,
  displayName?: string,
): Promise<SocialSignInResult> {
  const identity = await verifyGoogleIdToken(idToken);
  return resolveIdentity('google', identity, displayName);
}

export async function signInWithApple(
  idToken: string,
  displayName?: string,
): Promise<SocialSignInResult> {
  const identity = await verifyAppleIdToken(idToken);
  return resolveIdentity('apple', identity, displayName);
}
