import { prisma } from '@/db/prisma';

/**
 * The one place that guarantees a profile row exists.
 *
 * Lives apart from profiles.service to break an import cycle: the service needs
 * photos (for the primary photo URL) and photos need this. A cycle happens to
 * resolve at runtime under CommonJS, but only by accident of module ordering,
 * and it breaks the moment either file is imported in a different sequence.
 */

/**
 * Returns the profile id, creating the row if it is missing.
 *
 * Social and phone signups create a User with no Profile, so anything that
 * touches profile data has to be able to bring one into existence.
 */
export async function ensureProfile(userId: string): Promise<string> {
  const existing = await prisma.profile.findUnique({
    where: { user_id: userId },
    select: { id: true },
  });

  if (existing) {
    return existing.id;
  }

  const created = await prisma.profile.create({
    data: { user_id: userId },
    select: { id: true },
  });

  return created.id;
}
