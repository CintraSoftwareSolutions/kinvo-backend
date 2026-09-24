import {
  EMAIL_SENT,
  TransportHealth,
  emailRejected,
  emailUnavailable,
  type EmailDelivery,
  type EmailMessage,
  type EmailProvider,
} from '@/providers/email.provider';

/**
 * Remembers every email instead of sending it, so a test can read what would
 * have arrived.
 *
 * The outcome is fixed per instance, and the two failures are NOT
 * interchangeable: `rejecting` is one address the provider would not take, and
 * `unavailable` is the transport being down for everybody. Only the second is
 * something an endpoint may admit to, so a test that blurs them proves nothing.
 *
 * Swap it in with `setEmailProvider`, and swap it back out with
 * `setEmailProvider(null)` after each test.
 */
export class RecordingEmailProvider implements EmailProvider {
  readonly name = 'recording';
  readonly isConfigured = true;
  readonly sent: EmailMessage[] = [];

  /** The real one, so health behaves here exactly as it does in production. */
  private readonly health = new TransportHealth();

  constructor(private readonly outcome: EmailDelivery = EMAIL_SENT) {}

  /** Refuses each message for its recipient, as SES does in the sandbox. */
  static rejecting(): RecordingEmailProvider {
    return new RecordingEmailProvider(emailRejected('MessageRejected'));
  }

  /** Configured, but the transport itself refuses — a denied IAM policy. */
  static unavailable(): RecordingEmailProvider {
    return new RecordingEmailProvider(emailUnavailable('AccessDeniedException'));
  }

  get isReady(): boolean {
    return this.health.isReady;
  }

  /** As if an earlier request had already found the transport down. */
  markDown(): this {
    this.health.recordUnavailable();
    return this;
  }

  send(message: EmailMessage): Promise<EmailDelivery> {
    this.sent.push(message);

    if (this.outcome.status === 'unavailable') {
      this.health.recordUnavailable();
    } else {
      this.health.recordSent();
    }

    return Promise.resolve(this.outcome);
  }

  /** The emails addressed to [address]. */
  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }
}
