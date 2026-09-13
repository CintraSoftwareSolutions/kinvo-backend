import { UserStatus, prisma } from '@/db/prisma';
import { revokeAllTokensForUser } from '@modules/auth/token.service';
import { erasePersonalData } from '@modules/safety/erasure.service';
import { ApiError } from '@utils/api-error';
import { logger } from '@utils/logger';

/**
 * Account-level operations (spec §7, Batch 3).
 */

export interface DeleteAccountResult {
  deleted_at: string;
}

/**
 * Account deletion.
 *
 * A soft delete: `deleted_at` is stamped, the status moves to `deleted`, and
 * every session is revoked. The shared exclusion clause in
 * `@modules/safety/block.service` filters `deleted_at: null`, so the account
 * disappears from every read path immediately.
 *
 * Personal data IS scrubbed, by `erasePersonalData` in the safety module.
 * Identifying fields are destroyed; reports, moderation records, and payment
 * history survive pointing at a row that no longer says who it was. Otherwise
 * deleting your account would be the way to erase your own misconduct record.
 * See erasure.service.ts for what is kept and why.
 *
 * Idempotent: deleting twice returns the original timestamp rather than
 * erroring, so a retried request on a flaky connection is not a failure.
 */
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

  // Scrubbed after the soft delete, not inside it: the account must disappear
  // from every read path the instant the status changes, and erasure touches
  // enough tables that holding that transaction open would be the slowest write
  // in the system.
  await erasePersonalData(userId);

  logger.info({ user_id: userId }, 'account deleted');

  return { deleted_at: deletedAt.toISOString() };
}
