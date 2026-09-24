import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { logger } from '@utils/logger';
import {
  EMAIL_SENT,
  emailRejected,
  emailUnavailable,
  TransportHealth,
  type EmailDelivery,
  type EmailFailure,
  type EmailMessage,
  type EmailProvider,
} from './email.provider';

/**
 * Amazon SES (spec §3, Batch 11).
 *
 * Chosen over generic SMTP because it needs NO STATIC CREDENTIALS. On the
 * instance the SDK picks up the IAM role, exactly as the S3 client does, so
 * there is no long-lived password on the box to leak into an image, a backup,
 * or a support ticket. SMTP credentials would have re-introduced the one thing
 * the S3 setup deliberately avoids.
 *
 * THREE LIMITS THAT MATTER OPERATIONALLY:
 *
 *  1. A new SES account is in SANDBOX: it will only deliver to addresses that
 *     have been verified, and caps at 200 messages a day at one per second.
 *     Production access is a support request, and AWS asks how bounces and
 *     complaints are handled.
 *
 *  2. In the sandbox SES authorises against the RECIPIENT identity as well as
 *     the sender, so an IAM policy scoped to `identity/<sender>` denies every
 *     send to anybody else — an `AccessDeniedException` naming the recipient,
 *     which reads nothing like the sandbox rule that causes it. Staging ran that
 *     way from the first deploy until 24 Sep 2026: every password reset email
 *     was refused, and the API reported success regardless. The policy now
 *     allows `identity/*` and pins the sender with a `ses:FromAddress`
 *     condition, which survives production access being granted.
 *
 *  3. Without a verified DOMAIN there is no DKIM or SPF alignment, so what does
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

/**
 * Failures that are about the one recipient and nobody else: unverified while
 * the account is in the sandbox, suppressed after a hard bounce, malformed.
 *
 * Kept as an explicit list because the classification is asymmetric. Calling a
 * transport outage "rejected" costs one silent email — today's bug. Calling a
 * single undeliverable address an outage makes every other person's password
 * reset answer 503 until the health window passes, so the benefit of the doubt
 * belongs on this side of the line.
 */
const RECIPIENT_FAILURES = new Set(['MessageRejected', 'BadRequestException']);

/**
 * What a failed send means. Exported for its own unit tests: every branch here
 * needs SES to be in a state that is either hard or expensive to reach, and the
 * one that shipped broken was unreachable from the test suite entirely.
 */
export function classifySesFailure(error: unknown): EmailFailure {
  // Optional chaining, not a cast alone: a rejection with no value at all
  // would otherwise throw from inside the catch block that exists to stop
  // exactly that, and escape `send` as a 500 on somebody's password reset.
  const name = (error as { name?: string } | null | undefined)?.name ?? 'unknown';

  if (RECIPIENT_FAILURES.has(name)) return emailRejected(name);

  // Everything else — AccessDenied, AccountSuspended, SendingPaused,
  // MailFromDomainNotVerified, NotFound (a missing configuration set),
  // TooManyRequests, a timeout, a 5xx — is the transport rather than the
  // address, and so is anything unrecognised: an unknown failure that repeats
  // is an outage worth admitting to, and one that does not repeat is forgotten
  // within the minute.
  return emailUnavailable(name);
}

/**
 * The parts of a failed send that are safe to log — which is not the error.
 *
 * SES writes the RECIPIENT'S ADDRESS into the message of AccessDeniedException
 * and MessageRejected alike, and the stack repeats that message as its first
 * line, so handing the error to the logger put an email address in the logs on
 * every failure: redaction works on keys, not on text inside a string. The
 * subject stays out for a worse reason. For a password reset the subject IS the
 * code, and a code in the logs is a way into that account, for the next hour,
 * for anybody who can read them. Staging logged both on every refused reset
 * until 24 Sep 2026.
 *
 * What is kept is what a failure is chased with: the name this code branches
 * on, and the request id AWS support asks for.
 */
function describeSesFailure(error: unknown, reason: string): Record<string, unknown> {
  const metadata = (
    error as { $metadata?: { httpStatusCode?: number; requestId?: string } } | null | undefined
  )?.$metadata;

  return {
    provider: 'ses',
    reason,
    http_status: metadata?.httpStatusCode ?? null,
    aws_request_id: metadata?.requestId ?? null,
  };
}

export class SesEmailProvider implements EmailProvider {
  readonly name = 'ses';
  readonly isConfigured = true;

  private readonly client: SESv2Client;
  private readonly from: string;
  private readonly configurationSet: string | undefined;
  private readonly health = new TransportHealth();

  constructor(config: SesConfig) {
    this.from = config.from;
    this.configurationSet = config.configurationSet;
    // No credentials passed: the SDK resolves the instance role on EC2 and the
    // shared profile locally. Passing keys here would defeat the point.
    this.client = new SESv2Client({ region: config.region });
  }

  get isReady(): boolean {
    return this.health.isReady;
  }

  async send(message: EmailMessage): Promise<EmailDelivery> {
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

      this.health.recordSent();
      return EMAIL_SENT;
    } catch (error) {
      const delivery = classifySesFailure(error);
      const details = describeSesFailure(error, delivery.reason);

      if (delivery.status === 'unavailable') {
        this.health.recordUnavailable();
        // Distinct from the line below, so an alarm can match an outage and not
        // a bounce.
        logger.error(details, 'email transport unavailable');
      } else {
        logger.warn(details, 'email refused for that recipient');
      }

      return delivery;
    }
  }
}
