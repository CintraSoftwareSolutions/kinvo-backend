import { env } from '@config/env';
import type { EmailMessage } from '@/providers/email.provider';

/** "45 minutes", "1 hour", "2 hours" — whatever the configured TTL comes to. */
function formatValidity(minutes: number): string {
  if (minutes % 60 !== 0) {
    return `${minutes} minutes`;
  }

  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function passwordResetEmail(to: string, code: string): EmailMessage {
  const validFor = formatValidity(env.PASSWORD_RESET_TTL_MINUTES);

  const text = [
    'Someone asked to reset the password on your Kinvo account.',
    '',
    `Your code is ${code}`,
    '',
    `Enter it in the app within ${validFor}. It works once.`,
    '',
    "If this wasn't you, nothing has happened to your account and you can ignore",
    'this email. Your password stays as it is.',
  ].join('\n');

  // Inline styles and a single table-free column: every mail client renders
  // this, and there is no image, link or tracking pixel to be stripped, blocked
  // or mistaken for phishing.
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
        Someone asked to reset the password on your Kinvo account.
      </p>
      <p style="margin:0 0 8px;font-size:12px;letter-spacing:1.4px;color:#6b7280;">YOUR CODE</p>
      <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;">${code}</p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
        Enter it in the app within ${validFor}. It works once.
      </p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">
        If this wasn't you, nothing has happened to your account and you can ignore
        this email. Your password stays as it is.
      </p>
    </div>
  </body>
</html>`;

  return {
    to,
    subject: `${code} is your Kinvo password reset code`,
    text,
    html,
  };
}
