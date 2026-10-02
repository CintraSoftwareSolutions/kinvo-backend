import { prisma } from '@/db/prisma';

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
