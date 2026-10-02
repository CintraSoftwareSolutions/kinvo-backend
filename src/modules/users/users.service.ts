import { UserStatus, prisma } from '@/db/prisma';
import { revokeAllTokensForUser } from '@modules/auth/token.service';
import { erasePersonalData } from '@modules/safety/erasure.service';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

export interface DeleteAccountResult {
  deleted_at: string;
}

export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { deleted_at: true },
  });

  if (!user) {
    throw ApiError.notFound();
  }

  if (user.deleted_at) {
    return { deleted_at: user.deleted_at.toISOString() };
  }

  const deletedAt = new Date();

  await prisma.user.update({
    where: { id: userId },
    data: {
      deleted_at: deletedAt,
      status: UserStatus.deleted,
      // Out of every deck immediately, without waiting for a job to run.
      is_snoozed: true,
    },
  });

  // Sessions die with the account; a live access token must not outlive it.
  await revokeAllTokensForUser(userId);

  await erasePersonalData(userId);

  logger.info({ user_id: userId }, 'account deleted');

  return { deleted_at: deletedAt.toISOString() };
}
