import { getEmailProvider } from '@modules/notifications/providers';
import type { EmailMessage } from '@/providers/email.provider';
import { logger } from '@utils/logger';

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
        const outcome = await provider.send(compose({ name, email }));
        return { id, name, delivery: outcome.status === 'sent' ? 'emailed' : 'failed' };
      } catch (error) {
        logger.error({ err: error, contact_id: id }, 'trusted contact email failed');
        return { id, name, delivery: 'failed' };
      }
    }),
  );
}

export function countEmailed(alerts: ContactAlert[]): number {
  return alerts.filter((alert) => alert.delivery === 'emailed').length;
}

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
