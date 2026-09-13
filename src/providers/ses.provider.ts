import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { logger } from '@utils/logger';
import type { EmailMessage, EmailProvider } from './email.provider';

/**
 * Amazon SES (spec §3, Batch 11).
 *
 * Chosen over generic SMTP because it needs NO STATIC CREDENTIALS. On the
 * instance the SDK picks up the IAM role, exactly as the S3 client does, so
 * there is no long-lived password on the box to leak into an image, a backup,
 * or a support ticket. SMTP credentials would have re-introduced the one thing
 * the S3 setup deliberately avoids.
 *
 * TWO LIMITS THAT MATTER OPERATIONALLY:
 *
 *  1. A new SES account is in SANDBOX: it will only deliver to addresses that
 *     have been verified, and caps at 200 messages a day. Production access is
 *     a support request, and AWS asks how bounces and complaints are handled.
 *     Until it is granted, mail to a real user is accepted by the API and
 *     silently not delivered.
 *
 *  2. Without a verified DOMAIN there is no DKIM or SPF alignment, so what does
 *     get delivered is far more likely to land in spam. That is a deliverability
 *     problem, not a configuration one, and it needs the domain to fix.
 */

export interface SesConfig {
  region: string;
  /** Must be a verified identity, or every send is rejected. */
  from: string;
  /**
   * Attributes sending to a named set, which is what makes bounce and
   * complaint rates visible per-set in CloudWatch. Without it the events still
   * fire but land in the account-wide bucket, where transactional mail cannot
   * be told apart from anything else.
   */
  configurationSet?: string;
}

export class SesEmailProvider implements EmailProvider {
  readonly name = 'ses';
  readonly isConfigured = true;

  private readonly client: SESv2Client;
  private readonly from: string;
  private readonly configurationSet: string | undefined;

  constructor(config: SesConfig) {
    this.from = config.from;
    this.configurationSet = config.configurationSet;
    // No credentials passed: the SDK resolves the instance role on EC2 and the
    // shared profile locally. Passing keys here would defeat the point.
    this.client = new SESv2Client({ region: config.region });
  }

  async send(message: EmailMessage): Promise<boolean> {
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [message.to] },
          ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: message.text, Charset: 'UTF-8' },
                ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
              },
            },
          },
        }),
      );

      return true;
    } catch (error) {
      // Swallowed, like every other delivery failure in this module: the
      // notification is already in the feed, so a rejected email costs a
      // message in an inbox, never the notification itself.
      //
      // The recipient is deliberately not logged (spec §4: no PII in logs).
      logger.error({ err: error, subject: message.subject }, 'ses send failed');
      return false;
    }
  }
}
