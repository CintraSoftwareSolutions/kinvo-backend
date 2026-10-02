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


export interface SesConfig {
  region: string;
  from: string;
  configurationSet?: string;
}

const RECIPIENT_FAILURES = new Set(['MessageRejected', 'BadRequestException']);

export function classifySesFailure(error: unknown): EmailFailure {

  const name = (error as { name?: string } | null | undefined)?.name ?? 'unknown';

  if (RECIPIENT_FAILURES.has(name)) return emailRejected(name);

  return emailUnavailable(name);
}

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
