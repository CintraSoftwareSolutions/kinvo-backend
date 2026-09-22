import twilio, { type Twilio } from 'twilio';

import { env, thirdPartyIntegrationsRequired } from '@config/env';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { logger } from '@utils/logger';

/**
 * Twilio Verify (spec §2). Twilio generates, stores, and checks the code — we
 * never see or persist it, which keeps OTP secrets out of our database entirely.
 *
 * Behind an interface so tests mock this boundary and nothing below it.
 */

export interface OtpSendResult {
  status: string;
}

export interface OtpCheckResult {
  valid: boolean;
  status: string;
}

export interface OtpProvider {
  sendCode(phone: string): Promise<OtpSendResult>;
  checkCode(phone: string, code: string): Promise<OtpCheckResult>;
}

function hasCredentials(): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);
}

/**
 * Twilio failures that are about the number or the code rather than about
 * Twilio, turned into the error the caller should actually see.
 *
 * Both kinds arrive as the same exception, and treating all of them as an
 * outage told people to "try again shortly" when their number simply could not
 * receive a text — advice that can never work, on a screen they cannot get
 * past. Returns null when the failure really is Twilio's.
 *
 * Codes: https://www.twilio.com/docs/api/errors
 *
 * Exported so the mapping can be tested without a Twilio account.
 */
export function twilioRefusal(error: unknown): ApiError | null {
  const { status, code } = (error ?? {}) as { status?: number; code?: number };

  switch (code) {
    // 60200 invalid `To`, 60205 landline: numbers Twilio cannot text, whether
    // mistyped, fixed-line, or from a reserved range that only looks real.
    case 60200:
    case 60205:
      return ApiError.validation({
        phone: ['That number cannot receive a text. Check it and try again.'],
      });

    // Twilio's own limits, on top of ours. Both clear with time, and both mean
    // a new code rather than another attempt at the old one.
    case 60202:
      return new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'Too many wrong codes for that number. Ask for a new one.',
      );
    case 60203:
      return new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'Too many codes sent to that number. Wait a few minutes and try again.',
      );
    case 60212:
      return new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'That number has a code on its way already. Wait for it, or try again in a minute.',
      );
    default:
      break;
  }

  return status === 429 ? new ApiError(ERROR_CODES.RATE_LIMITED) : null;
}

let client: Twilio | null = null;

function getClient(): Twilio {
  if (!client) {
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

const twilioProvider: OtpProvider = {
  async sendCode(phone) {
    try {
      const verification = await getClient()
        .verify.v2.services(env.TWILIO_VERIFY_SERVICE_SID!)
        .verifications.create({ to: phone, channel: 'sms' });

      return { status: verification.status };
    } catch (error) {
      const refused = twilioRefusal(error);
      if (refused) {
        logger.warn({ err: error, phone_suffix: phone.slice(-4) }, 'twilio verify send refused');
        throw refused;
      }

      logger.error({ err: error }, 'twilio verify send failed');
      throw new ApiError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'We could not send a code right now. Please try again shortly.',
      );
    }
  },

  async checkCode(phone, code) {
    try {
      const check = await getClient()
        .verify.v2.services(env.TWILIO_VERIFY_SERVICE_SID!)
        .verificationChecks.create({ to: phone, code });

      return { valid: check.status === 'approved', status: check.status };
    } catch (error) {
      // Twilio returns 404 for an expired or already-consumed verification.
      // That is a wrong-code outcome, not an outage.
      const status = (error as { status?: number }).status;
      if (status === 404) {
        return { valid: false, status: 'expired' };
      }

      const refused = twilioRefusal(error);
      if (refused) {
        logger.warn({ err: error, phone_suffix: phone.slice(-4) }, 'twilio verify check refused');
        throw refused;
      }

      logger.error({ err: error }, 'twilio verify check failed');
      throw new ApiError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'We could not verify that code right now. Please try again shortly.',
      );
    }
  },
};

/**
 * Development stand-in for machines without Twilio credentials.
 *
 * Selected when Twilio is unconfigured AND the integration waiver is on. In a
 * real production deployment the waiver is at its default of `true`, so env
 * validation makes all three Twilio variables mandatory and this object can
 * never be reached — an OTP bypass in production would be catastrophic.
 *
 * It IS reachable wherever the waiver is on and the credentials are absent:
 * a developer's machine, CI, and a staging box whose Twilio parameters have not
 * been filled in. Staging's were filled in on 22 Sep 2026, so staging now sends
 * real texts and this stub is for local work.
 */
const DEV_CODE = '000000';

const stubProvider: OtpProvider = {
  async sendCode(phone) {
    logger.warn(
      { phone_suffix: phone.slice(-4) },
      `Twilio is not configured — no SMS sent. Use code ${DEV_CODE} to verify.`,
    );
    return Promise.resolve({ status: 'pending' });
  },

  async checkCode(_phone, code) {
    return Promise.resolve({
      valid: code === DEV_CODE,
      status: code === DEV_CODE ? 'approved' : 'pending',
    });
  },
};

export function getOtpProvider(): OtpProvider {
  if (hasCredentials()) {
    return twilioProvider;
  }

  if (thirdPartyIntegrationsRequired) {
    // Unreachable: env validation rejects a production boot without these.
    // Kept as a hard stop in case that validation is ever loosened.
    throw new Error('Twilio credentials are required in production');
  }

  // `thirdPartyIntegrationsRequired`, NOT `isProduction`. Staging runs with
  // NODE_ENV=production and the integration waiver on, and branching on
  // NODE_ENV alone made this throw there — so phone sign-in answered 500
  // instead of falling back, from Batch 2 until staging was finally exercised.
  logger.warn('Twilio is not configured and the integration waiver is on — using the OTP stub');

  return stubProvider;
}

export const DEV_OTP_CODE = DEV_CODE;
