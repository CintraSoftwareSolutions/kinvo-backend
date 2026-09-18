import { getEmailProvider } from '@modules/notifications/providers';
import type { EmailMessage } from '@/providers/email.provider';
import { logger } from '@utils/logger';

/**
 * Telling a user's trusted contacts something (spec §5.7): an emergency, a
 * plan, a call. By email, the one channel that works for every contact in
 * every country today; SMS can join it here without the callers changing.
 *
 * Every result says what really happened to each contact. The user is going
 * to rely on it to decide whether anyone knows where they are, so a contact
 * who wasn't reached must never read as told.
 */

/**
 * `already_told`: told about the same plan before, so not emailed again.
 */
export type ContactDelivery = 'emailed' | 'no_email' | 'failed' | 'already_told';

export interface ContactAlert {
  id: string;
  name: string;
  delivery: ContactDelivery;
}

export interface AlertableContact {
  id: string;
  name: string;
  email: string | null;
}

/** Emails each of [contacts] the message [compose] writes for them. */
export async function emailContacts(
  contacts: AlertableContact[],
  compose: (contact: { name: string; email: string }) => EmailMessage,
): Promise<ContactAlert[]> {
  const provider = getEmailProvider();

  return Promise.all(
    contacts.map(async (contact): Promise<ContactAlert> => {
      const { id, name, email } = contact;

      if (!email) {
        return { id, name, delivery: 'no_email' };
      }

      try {
        const sent = await provider.send(compose({ name, email }));
        return { id, name, delivery: sent ? 'emailed' : 'failed' };
      } catch (error) {
        // Providers report failure by returning false; this is the safety net
        // for one that throws. The contact id, never their address (spec §4).
        logger.error({ err: error, contact_id: id }, 'trusted contact email failed');
        return { id, name, delivery: 'failed' };
      }
    }),
  );
}

export function countEmailed(alerts: ContactAlert[]): number {
  return alerts.filter((alert) => alert.delivery === 'emailed').length;
}

/** What the user is told happened, for anything short of an emergency. */
export function deliverySummary(alerts: ContactAlert[]): string {
  const emailed = countEmailed(alerts);

  if (alerts.length === 0) {
    return 'You have no trusted contacts yet, so nobody was told.';
  }
  if (emailed === 0) {
    return "We couldn't email your trusted contacts.";
  }
  if (emailed === alerts.length) {
    return emailed === 1
      ? 'We emailed your trusted contact.'
      : `We emailed your ${emailed} trusted contacts.`;
  }
  return `We emailed ${emailed} of your ${alerts.length} trusted contacts.`;
}

/**
 * What the user is told happened to their emergency alert. Truthful above
 * all: it's what they'll decide their next move on.
 */
export function emergencySummary(alerts: ContactAlert[]): string {
  const emailed = countEmailed(alerts);

  if (alerts.length === 0) {
    return 'You have no trusted contacts yet. Call someone you trust, or your local emergency number.';
  }
  if (emailed === 0) {
    return "We couldn't email your trusted contacts. Call someone you trust, or your local emergency number.";
  }
  if (emailed === alerts.length) {
    return emailed === 1
      ? 'We emailed your trusted contact.'
      : `We emailed your ${emailed} trusted contacts.`;
  }
  return `We emailed ${emailed} of your ${alerts.length} trusted contacts. Call the others yourself.`;
}
