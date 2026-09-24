import nodemailer, { type Transporter } from 'nodemailer';

import { logger } from '@utils/logger';

/**
 * Email delivery boundary (spec §7, Batch 11).
 *
 * For notifications, email is delivery and never the record: every notification
 * is already in the feed before anything is sent here, so an SMTP outage costs a
 * message in an inbox, not a notification the user can never find.
 *
 * ONE MESSAGE BREAKS THAT RULE — the password reset code. Nothing else carries
 * it and there is no feed entry behind it, so for that one message delivery IS
 * the product. That is why `send` answers with an outcome rather than a boolean:
 * a transport that cannot send at all and an address that cannot be delivered to
 * were previously the same `false`, and they need opposite answers. The first is
 * ours to admit to. The second is a fact about somebody's address, and password
 * reset exists to refuse questions about addresses.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * What became of one message.
 *
 * - `sent` — the provider accepted it. Not proof it arrived; nothing is.
 * - `rejected` — the provider refused THIS RECIPIENT: unverified while SES is in
 *   the sandbox, suppressed after a hard bounce, malformed. Never reportable:
 *   whether an address can receive mail is a fact about the address.
 * - `unavailable` — the transport is not working: no credentials, a denied IAM
 *   policy, a paused account, the daily cap, a timeout. Nothing to do with the
 *   recipient, so it is safe to report and dishonest to hide.
 */
export type EmailDelivery =
  | { readonly status: 'sent' }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

export const EMAIL_SENT: EmailDelivery = { status: 'sent' };

export function emailRejected(reason: string): EmailDelivery {
  return { status: 'rejected', reason };
}

export function emailUnavailable(reason: string): EmailDelivery {
  return { status: 'unavailable', reason };
}

export interface EmailProvider {
  readonly name: string;
  readonly isConfigured: boolean;

  /**
   * Whether the transport last worked. Read before a message is composed, by
   * the one caller that has to refuse rather than fail silently.
   */
  readonly isReady: boolean;

  send(message: EmailMessage): Promise<EmailDelivery>;
}

/**
 * Whether the transport is working, remembered between sends.
 *
 * Password reset refuses honestly when email is down, and that refusal has to be
 * decided BEFORE the address is looked up — otherwise "we cannot send email" is
 * returned only for addresses that have an account, and the endpoint answers by
 * its error code the one question it exists to refuse. This is what that
 * decision is made from, and it is why the knowledge has to outlive the request
 * that discovered it.
 *
 * It forgets after [recoveryWindow]. A transport that has been fixed, or a blip,
 * must not leave the endpoint refusing for ever, and nothing else probes it —
 * the next request through is the probe.
 */
export class TransportHealth {
  private failedAt: number | null = null;

  constructor(
    private readonly recoveryWindow = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get isReady(): boolean {
    if (this.failedAt === null) return true;
    if (this.now() - this.failedAt < this.recoveryWindow) return false;

    this.failedAt = null;
    return true;
  }

  recordSent(): void {
    this.failedAt = null;
  }

  recordUnavailable(): void {
    this.failedAt = this.now();
  }
}

/** Runs until a mail transport exists, and in every test. */
export class NoopEmailProvider implements EmailProvider {
  readonly name = 'noop';
  readonly isConfigured = false;
  // Nothing is broken; there is simply nothing to send with. Callers branch on
  // `isConfigured` first, so this never reads as an outage.
  readonly isReady = false;

  send(message: EmailMessage): Promise<EmailDelivery> {
    // The recipient is deliberately not logged. Spec §4 forbids PII in logs,
    // and an email address is the most linkable identifier this system holds.
    logger.debug({ subject: message.subject }, 'email skipped — no provider configured');
    return Promise.resolve(emailUnavailable('no email provider configured'));
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/**
 * Nodemailer failures that are about the recipient rather than the transport.
 *
 * `EENVELOPE` is the server refusing a MAIL FROM or RCPT TO, and `EMESSAGE` the
 * message itself — the address or the content, not the connection. Everything
 * else (`EAUTH`, `ECONNECTION`, `ESOCKET`, `ETIMEDOUT`, `EDNS`) is the transport
 * being unusable, which is ours to admit to.
 */
const SMTP_RECIPIENT_FAILURES = new Set(['EENVELOPE', 'EMESSAGE']);

export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  readonly isConfigured = true;

  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly health = new TransportHealth();

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

  get isReady(): boolean {
    return this.health.isReady;
  }

  async send(message: EmailMessage): Promise<EmailDelivery> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      this.health.recordSent();
      return EMAIL_SENT;
    } catch (error) {
      const code = (error as { code?: string } | null | undefined)?.code ?? 'unknown';

      if (SMTP_RECIPIENT_FAILURES.has(code)) {
        logger.warn({ err: error, subject: message.subject }, 'email refused for that recipient');
        return emailRejected(code);
      }

      // Distinct from the line above so an alert can match the outage and not
      // the bounce. The recipient is never logged either way.
      this.health.recordUnavailable();
      logger.error(
        { err: error, subject: message.subject, provider: this.name, reason: code },
        'email transport unavailable',
      );
      return emailUnavailable(code);
    }
  }
}
