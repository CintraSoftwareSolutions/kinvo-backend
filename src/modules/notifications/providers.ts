import { env } from '@config/env';
import { FcmPushProvider } from '@/providers/fcm.provider';
import { NoopPushProvider, type PushProvider } from '@/providers/push.provider';
import {
  type EmailProvider,
  NoopEmailProvider,
  SmtpEmailProvider,
} from '@/providers/email.provider';
import { SesEmailProvider } from '@/providers/ses.provider';
import { logger } from '@utils/logger';

/**
 * Provider selection (spec §3, Batch 11).
 *
 * Both fall back to a no-op when credentials are absent, which is what lets the
 * whole module be built and tested before Firebase and SMTP accounts exist.
 * That is only safe because every notification is already persisted to the feed
 * before delivery is attempted — the user still sees it, they just do not get a
 * banner or an email.
 *
 * Resolved lazily so importing this module never reads credentials or opens a
 * connection. Tests import the app and must do neither.
 */

let push: PushProvider | null = null;
let email: EmailProvider | null = null;

export function getPushProvider(): PushProvider {
  if (!push) {
    const fcm = new FcmPushProvider(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    push = fcm.isConfigured ? fcm : new NoopPushProvider();

    if (!fcm.isConfigured) {
      logger.warn('push notifications disabled — FIREBASE_SERVICE_ACCOUNT_JSON is not set');
    }
  }

  return push;
}

export function getEmailProvider(): EmailProvider {
  if (!email) {
    // SES first: it authenticates with the instance role, so there is no
    // long-lived password on the box. SMTP remains as an escape hatch for an
    // environment that is not on AWS.
    if (env.SES_SENDER_ADDRESS) {
      email = new SesEmailProvider({
        region: env.S3_REGION,
        from: env.SES_SENDER_ADDRESS,
        configurationSet: env.SES_CONFIGURATION_SET,
      });
    } else if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD && env.SMTP_FROM) {
      email = new SmtpEmailProvider({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.SMTP_FROM,
      });
    } else {
      logger.warn('email notifications disabled — SMTP credentials are not set');
      email = new NoopEmailProvider();
    }
  }

  return email;
}

/** Tests swap in a spy; without a reset the swap leaks into the next suite. */
export function setPushProvider(provider: PushProvider | null): void {
  push = provider;
}

export function setEmailProvider(provider: EmailProvider | null): void {
  email = provider;
}
