import { TransportHealth } from '@/providers/email.provider';
import { classifySesFailure } from '@/providers/ses.provider';

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
