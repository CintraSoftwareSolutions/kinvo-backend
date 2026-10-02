import nodemailer, { type Transporter } from 'nodemailer';

import { logger } from '@utils/logger';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailDelivery = { readonly status: 'sent' } | EmailFailure;

export type EmailFailure =
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

export const EMAIL_SENT: EmailDelivery = { status: 'sent' };

export function emailRejected(reason: string): EmailFailure {
  return { status: 'rejected', reason };
}

export function emailUnavailable(reason: string): EmailFailure {
  return { status: 'unavailable', reason };
}

export interface EmailProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  readonly isReady: boolean;

  send(message: EmailMessage): Promise<EmailDelivery>;
}

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

export class NoopEmailProvider implements EmailProvider {
  readonly name = 'noop';
  readonly isConfigured = false;
  // Nothing is broken; there is simply nothing to send with. Callers branch on
  // `isConfigured` first, so this never reads as an outage.
  readonly isReady = false;

  send(): Promise<EmailDelivery> {
    // Neither the recipient nor the subject. Spec §4 forbids PII in logs, and
    // an email address is the most linkable identifier this system holds; for
    // a password reset, the subject is the code itself.
    logger.debug('email skipped — no provider configured');
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

const SMTP_RECIPIENT_FAILURES = new Set(['EENVELOPE', 'EMESSAGE']);

function describeSmtpFailure(error: unknown, reason: string): Record<string, unknown> {
  const failure = error as { responseCode?: number; command?: string } | null | undefined;

  return {
    provider: 'smtp',
    reason,
    smtp_response_code: failure?.responseCode ?? null,
    smtp_command: failure?.command ?? null,
  };
}

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
      const details = describeSmtpFailure(error, code);

      if (SMTP_RECIPIENT_FAILURES.has(code)) {
        logger.warn(details, 'email refused for that recipient');
        return emailRejected(code);
      }

      // Distinct from the line above, so an alarm can match an outage and not
      // a bounce.
      this.health.recordUnavailable();
      logger.error(details, 'email transport unavailable');
      return emailUnavailable(code);
    }
  }
}
