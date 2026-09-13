import type { OtpProvider } from '@/providers/twilio.provider';
import type { SocialIdentity } from '@/providers/google-auth.provider';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * Mocks for the three external HTTP services (spec §0.4: mock only external
 * HTTP; everything else runs against a real Postgres).
 *
 * These replace the provider modules, which are the seam where our code stops
 * and Twilio/Google/Apple begin. Nothing below that line is faked, so the
 * services, database writes, and identity-linking rules are all exercised for
 * real.
 */

// --- Twilio Verify -----------------------------------------------------------

export const VALID_OTP_CODE = '123456';

interface OtpCallLog {
  sent: string[];
  checked: { phone: string; code: string }[];
}

export const otpCalls: OtpCallLog = { sent: [], checked: [] };

export function resetOtpCalls(): void {
  otpCalls.sent = [];
  otpCalls.checked = [];
}

/** Accepts VALID_OTP_CODE for any number and rejects everything else. */
export const mockOtpProvider: OtpProvider = {
  sendCode(phone) {
    otpCalls.sent.push(phone);
    return Promise.resolve({ status: 'pending' });
  },
  checkCode(phone, code) {
    otpCalls.checked.push({ phone, code });
    const valid = code === VALID_OTP_CODE;
    return Promise.resolve({ valid, status: valid ? 'approved' : 'pending' });
  },
};

// --- Google and Apple --------------------------------------------------------

/**
 * Test ID tokens are plain JSON, not real JWTs. The mock stands in for the
 * whole verify step, so signature checking is out of scope here by design —
 * what these tests exercise is the identity-resolution and linking rules that
 * run *after* verification succeeds.
 */
export function fakeIdToken(identity: Partial<SocialIdentity> & { subject: string }): string {
  return JSON.stringify({
    subject: identity.subject,
    email: identity.email ?? null,
    email_verified: identity.email_verified ?? false,
    name: identity.name ?? null,
  });
}

export const INVALID_ID_TOKEN = 'not-a-valid-token';

export function decodeFakeIdToken(idToken: string): SocialIdentity {
  return JSON.parse(idToken) as SocialIdentity;
}

/**
 * Stand-ins for the provider verify functions.
 *
 * Named with a `mock` prefix so they may be referenced inside a hoisted
 * `jest.mock` factory. They live here rather than inline in the suite so
 * ApiError can be imported normally instead of through `requireActual`.
 */
function rejectIfInvalid(idToken: string, provider: string): Promise<SocialIdentity> {
  if (idToken === INVALID_ID_TOKEN) {
    return Promise.reject(
      new ApiError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        `That ${provider} sign-in could not be verified.`,
      ),
    );
  }
  return Promise.resolve(decodeFakeIdToken(idToken));
}

export function mockVerifyGoogleIdToken(idToken: string): Promise<SocialIdentity> {
  return rejectIfInvalid(idToken, 'Google');
}

export function mockVerifyAppleIdToken(idToken: string): Promise<SocialIdentity> {
  return rejectIfInvalid(idToken, 'Apple');
}
