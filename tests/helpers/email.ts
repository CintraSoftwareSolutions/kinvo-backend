import type { EmailMessage, EmailProvider } from '@/providers/email.provider';

/**
 * Remembers every email instead of sending it, so a test can read what would
 * have arrived. Constructed with `false`, it refuses every send the way a real
 * provider reports a rejected message.
 *
 * Swap it in with `setEmailProvider`, and swap it back out with
 * `setEmailProvider(null)` after each test.
 */
export class RecordingEmailProvider implements EmailProvider {
  readonly name = 'recording';
  readonly isConfigured = true;
  readonly sent: EmailMessage[] = [];

  constructor(private readonly delivers = true) {}

  send(message: EmailMessage): Promise<boolean> {
    this.sent.push(message);
    return Promise.resolve(this.delivers);
  }

  /** The emails addressed to [address]. */
  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }
}
