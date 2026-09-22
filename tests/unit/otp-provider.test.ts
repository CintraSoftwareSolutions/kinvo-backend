import { DEV_OTP_CODE, getOtpProvider, twilioRefusal } from '@/providers/twilio.provider';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * The development fallback used when Twilio credentials are absent.
 *
 * This is security-relevant code — it accepts a fixed code — so it is tested
 * rather than assumed. It is safe by construction because env validation makes
 * all three Twilio variables mandatory in production, and it carries a second
 * NODE_ENV guard on top of that. Tests run with no Twilio credentials, so this
 * is the provider they get.
 */

describe('OTP provider selection without credentials', () => {
  it('falls back to the development stub', () => {
    const provider = getOtpProvider();

    expect(provider).toBeDefined();
    expect(typeof provider.sendCode).toBe('function');
    expect(typeof provider.checkCode).toBe('function');
  });

  it('reports a send without contacting anyone', async () => {
    const result = await getOtpProvider().sendCode('+447700900123');
    expect(result.status).toBe('pending');
  });

  it('accepts the documented development code', async () => {
    const result = await getOtpProvider().checkCode('+447700900123', DEV_OTP_CODE);

    expect(result.valid).toBe(true);
    expect(result.status).toBe('approved');
  });

  it('rejects anything else', async () => {
    const result = await getOtpProvider().checkCode('+447700900123', '111111');

    expect(result.valid).toBe(false);
    expect(result.status).not.toBe('approved');
  });

  it('uses a code that could not be mistaken for a real one', () => {
    expect(DEV_OTP_CODE).toBe('000000');
  });
});

/**
 * Twilio answers "that number is not real" and "Twilio is having a bad day"
 * through the same exception. Staging returned 503 "try again shortly" for a
 * number that could never receive a text, which is advice nobody can act on,
 * on the one screen they cannot get past — so the mapping is pinned here.
 */
describe('turning a Twilio failure into an answer', () => {
  /** Shaped like the `RestException` the SDK throws. */
  function restException(code: number, status = 400): Error {
    return Object.assign(new Error('twilio said no'), { code, status });
  }

  it('reports a number that cannot be texted against the field', () => {
    const refusal = twilioRefusal(restException(60200));

    expect(refusal?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(refusal?.statusCode).toBe(400);
    expect(refusal?.details).toEqual({
      phone: ['That number cannot receive a text. Check it and try again.'],
    });
  });

  it('treats a landline the same way', () => {
    expect(twilioRefusal(restException(60205))?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it.each([
    [60202, 'too many wrong codes'],
    [60203, 'too many codes sent'],
    [60212, 'a code already on its way'],
  ])('reports %i as a rate limit (%s)', (code) => {
    const refusal = twilioRefusal(restException(code, 429));

    expect(refusal?.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(refusal?.statusCode).toBe(429);
  });

  it('reports a bare 429 as a rate limit even with no code', () => {
    expect(twilioRefusal({ status: 429 })?.code).toBe(ERROR_CODES.RATE_LIMITED);
  });

  it('leaves a real outage alone, so it is logged and answered as one', () => {
    expect(twilioRefusal(restException(20500, 500))).toBeNull();
    expect(twilioRefusal(new Error('socket hang up'))).toBeNull();
    expect(twilioRefusal(undefined)).toBeNull();
  });

  it('leaves an account that is not allowed to text to the outage path', () => {
    // 21608 (no compliance profile) and 21408 (country switched off) are not
    // about the number, so they must not come back as a field error — the
    // person typing it can do nothing about either.
    expect(twilioRefusal(restException(21608, 403))).toBeNull();
    expect(twilioRefusal(restException(21408, 403))).toBeNull();
  });

  it('never leaks the number into the message', () => {
    const refusal = twilioRefusal(restException(60200));

    expect(JSON.stringify(refusal?.details)).not.toContain('+');
  });
});
