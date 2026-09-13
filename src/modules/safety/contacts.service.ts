import { prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';

/**
 * Trusted contacts (spec §5.7, Batch 12).
 *
 * People outside Kinvo who receive plan and safety updates — a friend, a
 * flatmate, a parent. They have no account here and never see the app; they are
 * a phone number or an email the user nominated.
 *
 * That makes this the most sensitive personal data in the product after live
 * location: it is contact details for THIRD PARTIES who never agreed to
 * anything. It is never surfaced to anyone but the user who entered it, and it
 * is scrubbed on account deletion.
 */

const MAX_CONTACTS = 5;

export interface TrustedContactView {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  created_at: string;
}

function toView(contact: {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  created_at: Date;
}): TrustedContactView {
  return {
    id: contact.id,
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    relationship: contact.relationship,
    created_at: contact.created_at.toISOString(),
  };
}

export async function listContacts(userId: string): Promise<TrustedContactView[]> {
  const contacts = await prisma.trustedContact.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'asc' },
  });

  return contacts.map(toView);
}

export interface UpsertContactInput {
  name: string;
  phone?: string;
  email?: string;
  relationship?: string;
}

export async function createContact(
  userId: string,
  input: UpsertContactInput,
): Promise<TrustedContactView> {
  // At least one way to reach them, or the contact is decoration — and the
  // moment it matters is the moment nobody checks whether it works.
  if (!input.phone && !input.email) {
    throw ApiError.validation({
      phone: ['Give a phone number or an email so this contact can be reached.'],
    });
  }

  const count = await prisma.trustedContact.count({ where: { user_id: userId } });

  if (count >= MAX_CONTACTS) {
    throw ApiError.badRequest(`You can have at most ${MAX_CONTACTS} trusted contacts.`, {
      limit: MAX_CONTACTS,
    });
  }

  const contact = await prisma.trustedContact.create({
    data: {
      user_id: userId,
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      relationship: input.relationship ?? null,
    },
  });

  return toView(contact);
}

export async function updateContact(
  userId: string,
  contactId: string,
  input: Partial<UpsertContactInput>,
): Promise<TrustedContactView> {
  const existing = await prisma.trustedContact.findFirst({
    where: { id: contactId, user_id: userId },
  });

  // Scoped to the caller: another user's contact id is a 404, never a 403 that
  // would confirm it exists.
  if (!existing) {
    throw ApiError.notFound();
  }

  const phone = input.phone === undefined ? existing.phone : input.phone || null;
  const email = input.email === undefined ? existing.email : input.email || null;

  if (!phone && !email) {
    throw ApiError.validation({
      phone: ['A trusted contact needs a phone number or an email.'],
    });
  }

  const updated = await prisma.trustedContact.update({
    where: { id: contactId },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      phone,
      email,
      ...(input.relationship === undefined ? {} : { relationship: input.relationship || null }),
    },
  });

  return toView(updated);
}

export async function deleteContact(userId: string, contactId: string): Promise<void> {
  const deleted = await prisma.trustedContact.deleteMany({
    where: { id: contactId, user_id: userId },
  });

  if (deleted.count === 0) {
    throw ApiError.notFound();
  }
}

export { MAX_CONTACTS };
