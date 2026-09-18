import type { EmailMessage } from '@/providers/email.provider';
import type { Coordinates } from '@/db/geo';

/**
 * Emails to a user's trusted contacts, and to the safety team (spec §5.7).
 *
 * Everything a user typed — their name, a contact's name, a place, a note — is
 * escaped before it goes into HTML, so nobody can put markup, or a link that
 * isn't what it says, into an email that arrives with Kinvo's name on it.
 */

/** A plan, as a trusted contact is told about it. */
export interface PlanForContact {
  /** The other person's name, as they show it on Kinvo. */
  withName: string;
  place: string;
  address: string | null;
  at: Date | null;
  durationMinutes: number | null;
}

/**
 * A time as the reader should see it: in the sender's own time, which the app
 * gives as its offset from UTC, since the server knows nobody's time zone.
 * "Saturday 20 September at 19:00 (UTC+01:00)". UTC when no offset was given.
 */
export function formatForReader(at: Date, utcOffsetMinutes?: number): string {
  const offset = utcOffsetMinutes ?? 0;
  const shifted = new Date(at.getTime() + offset * 60_000);
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(shifted);

  return `${text} (${offsetLabel(offset)})`;
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) {
    return 'UTC';
  }

  const sign = minutes > 0 ? '+' : '-';
  const size = Math.abs(minutes);
  const hours = String(Math.floor(size / 60)).padStart(2, '0');
  const rest = String(size % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${rest}`;
}

/** A map pin, which opens in whatever maps app the reader has. */
export function mapsLink(coordinates: Coordinates): string {
  return `https://www.google.com/maps/search/?api=1&query=${coordinates.latitude},${coordinates.longitude}`;
}

function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = hours === 0 ? '' : hours === 1 ? '1 hour' : `${hours} hours`;

  if (rest === 0) {
    return hourPart;
  }

  return hourPart ? `${hourPart} ${rest} minutes` : `${rest} minutes`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A subject line can't be allowed to carry a line break into the headers. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Plain paragraphs to both bodies. A paragraph may hold one link, [href],
 * shown as its own text: the reader sees exactly where it goes.
 */
function compose(
  to: string,
  subject: string,
  paragraphs: { text: string; href?: string }[],
): EmailMessage {
  const text = paragraphs.map((paragraph) => paragraph.text).join('\n\n');

  const body = paragraphs
    .map(({ text: paragraph, href }) => {
      const content = href
        ? `<a href="${escapeHtml(href)}" style="color:#6d28d9;">${escapeHtml(paragraph)}</a>`
        : escapeHtml(paragraph).replace(/\n/g, '<br>');
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${content}</p>`;
    })
    .join('\n      ');

  // Inline styles and a single column, like every Kinvo email: it renders in
  // every mail client, with no image or tracking pixel to be blocked.
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
      ${body}
    </div>
  </body>
</html>`;

  return { to, subject: oneLine(subject), text, html };
}

function why(senderName: string): { text: string } {
  return {
    text: `You are getting this because ${senderName} added you as a trusted contact in the Kinvo app.`,
  };
}

function planLines(plan: PlanForContact, utcOffsetMinutes?: number): { text: string }[] {
  const where = plan.address ? `${plan.place}, ${plan.address}` : plan.place;
  const lines = [`Where: ${where}`];

  if (plan.at) {
    lines.push(`When: ${formatForReader(plan.at, utcOffsetMinutes)}`);
  }
  if (plan.durationMinutes) {
    lines.push(`For about: ${durationLabel(plan.durationMinutes)}`);
  }

  return [{ text: lines.join('\n') }];
}

export function emergencyAlertEmail(input: {
  to: string;
  contactName: string;
  senderName: string;
  at: Date;
  utcOffsetMinutes?: number;
  coordinates: Coordinates | null;
  note: string | null;
  plan: PlanForContact | null;
}): EmailMessage {
  const { senderName, plan, coordinates, note } = input;

  return compose(input.to, `${senderName} needs help: a Kinvo safety alert`, [
    { text: `Hi ${input.contactName},` },
    {
      text: `${senderName} pressed the emergency button in the Kinvo app on ${formatForReader(
        input.at,
        input.utcOffsetMinutes,
      )}.`,
    },
    ...(coordinates
      ? [
          // The app only knows roughly where the phone is, so say so.
          { text: 'Roughly where they were when they pressed it:' },
          { text: mapsLink(coordinates), href: mapsLink(coordinates) },
        ]
      : []),
    ...(note ? [{ text: `Their message: "${note}"` }] : []),
    ...(plan
      ? [
          {
            text: `They had a plan to meet ${plan.withName}, someone they met on Kinvo.`,
          },
          ...planLines(plan, input.utcOffsetMinutes),
        ]
      : []),
    {
      text: `Please try to reach ${senderName} now. If you think they are in danger, call your local emergency number.`,
    },
    why(senderName),
  ]);
}

export function planSharedEmail(input: {
  to: string;
  contactName: string;
  senderName: string;
  plan: PlanForContact;
  utcOffsetMinutes?: number;
}): EmailMessage {
  const { senderName, plan } = input;

  return compose(input.to, `${senderName} shared their plans with you`, [
    { text: `Hi ${input.contactName},` },
    {
      text: `${senderName} is meeting ${plan.withName}, someone they met on Kinvo, and wanted you to know where and when.`,
    },
    ...planLines(plan, input.utcOffsetMinutes),
    {
      text: `If you don't hear from ${senderName} when you expect to, try to reach them.`,
    },
    why(senderName),
  ]);
}

export function callUpdateEmail(input: {
  to: string;
  contactName: string;
  senderName: string;
  withName: string;
}): EmailMessage {
  const { senderName } = input;

  return compose(input.to, `${senderName} is on a Kinvo video call`, [
    { text: `Hi ${input.contactName},` },
    {
      text: `${senderName} is on a video call with ${input.withName}, someone they met on Kinvo, and asked us to let you know.`,
    },
    { text: `If you're worried, try to reach ${senderName}.` },
    why(senderName),
  ]);
}

/**
 * The safety team's copy of an emergency. Identifiers rather than contact
 * details: whoever reads it looks the rest up in the admin tools.
 */
export function safetyTeamEmail(input: {
  to: string;
  eventId: string;
  userId: string;
  at: Date;
  coordinates: Coordinates | null;
  note: string | null;
  contactsEmailed: number;
  contactsTotal: number;
}): EmailMessage {
  return compose(input.to, `Emergency alert ${input.eventId}`, [
    {
      text: [
        `Emergency event: ${input.eventId}`,
        `User: ${input.userId}`,
        `Raised: ${input.at.toISOString()}`,
        `Trusted contacts emailed: ${input.contactsEmailed} of ${input.contactsTotal}`,
        `Message: ${input.note ?? 'none'}`,
      ].join('\n'),
    },
    input.coordinates
      ? { text: mapsLink(input.coordinates), href: mapsLink(input.coordinates) }
      : { text: 'No location was shared.' },
  ]);
}
