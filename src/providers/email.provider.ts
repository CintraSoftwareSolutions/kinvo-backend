import nodemailer, { type Transporter } from 'nodemailer';

import { logger } from '@utils/logger';

/**
 * Email delivery boundary (spec §7, Batch 11).
 *
 * Same rule as push: email is delivery, never the record. Every notification is
 * already in the feed before anything is sent here, so an SMTP outage costs a
 * message in an inbox, not a notification the user can never find.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  send(message: EmailMessage): Promise<boolean>;
}

/** Runs until SMTP credentials exist, and in every test. */
export class NoopEmailProvider implements EmailProvider {
  readonly name = 'noop';
  readonly isConfigured = false;

  send(message: EmailMessage): Promise<boolean> {
    // The recipient is deliberately not logged. Spec §4 forbids PII in logs,
    // and an email address is the most linkable identifier this system holds.
    logger.debug({ subject: message.subject }, 'email skipped — no provider configured');
    return Promise.resolve(false);
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  readonly isConfigured = true;

  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpConfig) {
    this.from = config.from;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this backwards
      // produces a hang rather than an error, which is a miserable thing to
      // debug at deploy time.
      secure: config.port === 465,
      auth: { user: config.user, pass: config.password },
    });
  }

  async send(message: EmailMessage): Promise<boolean> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      return true;
    } catch (error) {
      logger.error({ err: error, subject: message.subject }, 'email send failed');
      return false;
    }
  }
}
