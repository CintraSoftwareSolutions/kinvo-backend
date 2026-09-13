import { DEV_OTP_CODE, getOtpProvider } from '@/providers/twilio.provider';

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
