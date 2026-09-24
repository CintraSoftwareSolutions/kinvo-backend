import { SESv2Client } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';

import { SmtpEmailProvider, TransportHealth } from '@/providers/email.provider';
import { SesEmailProvider, classifySesFailure } from '@/providers/ses.provider';
import { logger } from '@utils/logger';

/**
 * Why these are unit tests: every branch needs SES to be in a state that is
 * either hard or expensive to reach, and the one that actually shipped broken —
 * a policy denying the send — was unreachable from the integration suite
 * entirely. It sat in staging refusing every password reset email while the API
 * reported success, because nothing anywhere could tell the two apart.
 */
describe('classifySesFailure', () => {
  const failure = (name: string): unknown => Object.assign(new Error('refused'), { name });

  it('reads a refused message as being about that recipient', () => {
    // What the sandbox answers for an address nobody has verified. It is a fact
    // about the address, so it may never reach the caller.
    expect(classifySesFailure(failure('MessageRejected'))).toEqual({
      status: 'rejected',
      reason: 'MessageRejected',
    });
  });

  it('reads a malformed request as being about that recipient', () => {
    expect(classifySesFailure(failure('BadRequestException')).status).toBe('rejected');
  });

  it('reads a denied policy as the transport being down', () => {
    expect(classifySesFailure(failure('AccessDeniedException'))).toEqual({
      status: 'unavailable',
      reason: 'AccessDeniedException',
    });
  });

  it('reads the daily cap and a paused account as the transport being down', () => {
    expect(classifySesFailure(failure('TooManyRequestsException')).status).toBe('unavailable');
    expect(classifySesFailure(failure('AccountSuspendedException')).status).toBe('unavailable');
    expect(classifySesFailure(failure('SendingPausedException')).status).toBe('unavailable');
  });

  it('reads anything unrecognised as the transport being down', () => {
    // The safe direction. An unknown failure that repeats is an outage worth
    // admitting to; one that does not repeat is forgotten within the minute.
    expect(classifySesFailure(failure('SomethingNewFromAws')).status).toBe('unavailable');
    expect(classifySesFailure(new Error('socket hang up')).status).toBe('unavailable');
    expect(classifySesFailure(undefined).status).toBe('unavailable');
  });
});

describe('TransportHealth', () => {
  /** A clock the test moves, since the window is a minute of real time. */
  function at(start = 0): { health: TransportHealth; advance: (ms: number) => void } {
    let now = start;
    const health = new TransportHealth(60_000, () => now);
    return { health, advance: (ms) => (now += ms) };
  }

  it('starts ready, because nothing has failed yet', () => {
    expect(at().health.isReady).toBe(true);
  });

  it('is not ready once the transport has failed', () => {
    const { health } = at();
    health.recordUnavailable();
    expect(health.isReady).toBe(false);
  });

  it('is ready again after the window, so a fixed transport recovers itself', () => {
    const { health, advance } = at();
    health.recordUnavailable();

    advance(59_000);
    expect(health.isReady).toBe(false);

    // Nothing probes the transport, so the next request through has to be the
    // probe — otherwise a one-minute blip refuses password resets for ever.
    advance(2_000);
    expect(health.isReady).toBe(true);
  });

  it('is ready again the moment something sends', () => {
    const { health } = at();
    health.recordUnavailable();
    health.recordSent();
    expect(health.isReady).toBe(true);
  });
});

/**
 * What a failed send leaves in the logs.
 *
 * Both providers used to hand the raw error and the subject to the logger. The
 * logger redacts KEYS, not text inside strings, so every refused password reset
 * logged the recipient's address — SES writes it into the error message, and
 * the stack repeats it — and the subject, which for a reset is the code itself.
 * Anybody who could read the logs could reset that account for the next hour.
 */
describe('what a failed send logs', () => {
  const recipient = 'someone@example.com';
  const code = '482913';
  const message = {
    to: recipient,
    subject: `${code} is your Kinvo password reset code`,
    text: `Your code is ${code}.`,
  };

  /** Everything handed to the logger, as one string to search. */
  function captureLogs(): () => string {
    const calls = [
      jest.spyOn(logger, 'error').mockImplementation(() => undefined),
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    ];
    return () => JSON.stringify(calls.flatMap((spy) => spy.mock.calls));
  }

  describe('over SES', () => {
    /** Shaped as SES really answers: the recipient inside the message. */
    function sesRefusal(name: string, text: string): Error {
      return Object.assign(new Error(text), {
        name,
        $metadata: { httpStatusCode: 403, requestId: 'aws-request-1' },
      });
    }

    async function sendThrough(refusal: Error): Promise<{ status: string; logs: string }> {
      jest.spyOn(SESv2Client.prototype, 'send').mockRejectedValue(refusal as never);
      const logs = captureLogs();

      const provider = new SesEmailProvider({ region: 'us-east-1', from: 'sender@example.com' });
      const delivery = await provider.send(message);

      return { status: delivery.status, logs: logs() };
    }

    it('keeps the address and the code out of an outage', async () => {
      // Word for word what staging logged on 24 Sep 2026, apart from the ids.
      const { status, logs } = await sendThrough(
        sesRefusal(
          'AccessDeniedException',
          `User 'arn:aws:sts::1:assumed-role/kinvo/i-1' is not authorized to perform ` +
            `'ses:SendEmail' on resource 'arn:aws:ses:us-east-1:1:identity/${recipient}'`,
        ),
      );

      expect(status).toBe('unavailable');
      expect(logs).not.toContain(recipient);
      expect(logs).not.toContain(code);
      // What a failure is chased with survives.
      expect(logs).toContain('AccessDeniedException');
      expect(logs).toContain('aws-request-1');
    });

    it('keeps the address and the code out of a refused recipient', async () => {
      const { status, logs } = await sendThrough(
        sesRefusal(
          'MessageRejected',
          `Email address is not verified. The following identities failed the check ` +
            `in region US-EAST-1: ${recipient}`,
        ),
      );

      expect(status).toBe('rejected');
      expect(logs).not.toContain(recipient);
      expect(logs).not.toContain(code);
      expect(logs).toContain('MessageRejected');
    });
  });

  describe('over SMTP', () => {
    async function sendThrough(refusal: Error): Promise<{ status: string; logs: string }> {
      jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
        sendMail: jest.fn().mockRejectedValue(refusal),
      } as never);
      const logs = captureLogs();

      const provider = new SmtpEmailProvider({
        host: 'smtp.example.com',
        port: 587,
        user: 'user',
        password: 'password',
        from: 'sender@example.com',
      });
      const delivery = await provider.send(message);

      return { status: delivery.status, logs: logs() };
    }

    it('keeps the address and the code out of a refused recipient', async () => {
      // Nodemailer puts the address in the message AND in the server's reply.
      const response = `550 5.1.1 <${recipient}>: Recipient address rejected`;
      const { status, logs } = await sendThrough(
        Object.assign(new Error(`Can't send mail - all recipients were rejected: ${response}`), {
          code: 'EENVELOPE',
          response,
          responseCode: 550,
          command: 'RCPT TO',
        }),
      );

      expect(status).toBe('rejected');
      expect(logs).not.toContain(recipient);
      expect(logs).not.toContain(code);
      expect(logs).toContain('RCPT TO');
    });

    it('keeps the code out of an outage', async () => {
      const { status, logs } = await sendThrough(
        Object.assign(new Error('Invalid login: 535 Authentication failed'), {
          code: 'EAUTH',
          responseCode: 535,
          command: 'AUTH PLAIN',
        }),
      );

      expect(status).toBe('unavailable');
      expect(logs).not.toContain(code);
      expect(logs).toContain('EAUTH');
    });
  });
});
