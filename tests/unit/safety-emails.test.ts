import {
  emergencyAlertEmail,
  formatForReader,
  mapsLink,
  planSharedEmail,
} from '@modules/safety/safety.emails';

/**
 * Emails to trusted contacts (spec §5.7). The server knows nobody's time zone,
 * so a time is shown in the offset the app sent, and labelled with it.
 */

const SATURDAY_SIX_PM_UTC = new Date('2026-09-19T18:00:00.000Z');

describe('formatForReader', () => {
  it('shows the time in the sender’s offset, and says which', () => {
    const text = formatForReader(SATURDAY_SIX_PM_UTC, 60);

    expect(text).toContain('Saturday');
    expect(text).toContain('19:00');
    expect(text).toContain('(UTC+01:00)');
  });

  it('handles offsets west of UTC and half hours', () => {
    expect(formatForReader(SATURDAY_SIX_PM_UTC, -330)).toContain('12:30');
    expect(formatForReader(SATURDAY_SIX_PM_UTC, -330)).toContain('(UTC-05:30)');
  });

  it('says UTC when the app sent no offset', () => {
    const text = formatForReader(SATURDAY_SIX_PM_UTC);

    expect(text).toContain('18:00');
    expect(text).toContain('(UTC)');
  });

  it('moves to the next day when the offset crosses midnight', () => {
    expect(formatForReader(new Date('2026-09-19T22:30:00.000Z'), 120)).toContain('Sunday');
  });
});

describe('the emails', () => {
  it('link to the position the user shared', () => {
    expect(mapsLink({ latitude: 51.5072, longitude: -0.1276 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=51.5072,-0.1276',
    );
  });

  it('keep what the user typed as text, never markup', () => {
    const email = emergencyAlertEmail({
      to: 'sister@example.com',
      contactName: 'Sam & Jo',
      senderName: '<i>Alex</i>',
      at: SATURDAY_SIX_PM_UTC,
      coordinates: null,
      note: '<a href="https://evil.example">tap here</a>',
      plan: null,
    });

    expect(email.html).not.toContain('<i>Alex</i>');
    expect(email.html).not.toContain('<a href="https://evil.example">');
    expect(email.html).toContain('Sam &amp; Jo');
    // The plain text is plain: nothing to escape there.
    expect(email.text).toContain('<i>Alex</i> pressed the emergency button');
  });

  it('keep line breaks out of the subject', () => {
    const email = planSharedEmail({
      to: 'sister@example.com',
      contactName: 'Sister',
      senderName: 'Alex\r\nBcc: someone@example.com',
      plan: {
        withName: 'Blake',
        place: 'The ramen bar',
        address: null,
        at: SATURDAY_SIX_PM_UTC,
        durationMinutes: 90,
      },
    });

    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text).toContain('For about: 1 hour 30 minutes');
  });
});
