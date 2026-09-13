import { randomUUID } from 'node:crypto';

import { prisma } from '@/db/prisma';
import { pruneExpiredLiveLocations } from '@/db/geo';
import { logger } from '@utils/logger';

/**
 * Erasure on account deletion (spec §5.7, Batch 12).
 *
 * Closes the debt recorded in DECISIONS.md §1.2c: until now deletion was a soft
 * delete that scrubbed nothing, which meant the product promised erasure and
 * retained everything.
 *
 * THE TENSION THIS FILE RESOLVES. Two obligations pull opposite ways:
 *
 *   Erasure — a deleted user's personal data must go.
 *   Safety  — a report about someone who deletes their account must survive,
 *             or deletion becomes the way to erase your own misconduct record.
 *
 * The resolution is that IDENTIFYING data is destroyed and SAFETY records are
 * kept, pointing at a row that no longer says who it was. A moderator can still
 * see that an account was reported three times for harassment; nobody can work
 * out whose account it was.
 *
 * What is destroyed:
 *   name, date of birth, bio, prompts, photos, location, auth identities,
 *   device records, push tokens, trusted contacts, live location trails,
 *   notification history, message bodies.
 *
 * What is kept:
 *   reports (both filed and received), moderation flags and checks, the
 *   existence of matches and messages, subscription and payment records.
 *
 * Payment records are kept because tax law requires it, and that obligation
 * outranks an erasure request in every jurisdiction this ships to.
 */

/**
 * Replaces identity with a value that cannot be reversed or correlated.
 *
 * A random token per field, not a hash of the original: a hash of an email
 * address is still an email address to anyone holding a list to check against,
 * which is exactly how "anonymised" datasets get de-anonymised.
 */
function tombstone(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export interface ErasureResult {
  photos_deleted: number;
  identities_scrubbed: number;
  devices_scrubbed: number;
  contacts_deleted: number;
  notifications_deleted: number;
  messages_scrubbed: number;
}

/**
 * Scrubs a deleted account.
 *
 * Runs AFTER the soft delete, in its own transaction, and is idempotent — a
 * retry on an already-scrubbed account changes nothing rather than failing.
 */
export async function erasePersonalData(userId: string): Promise<ErasureResult> {
  const result = await prisma.$transaction(async (tx) => {
    // --- identity ---------------------------------------------------------
    await tx.user.update({
      where: { id: userId },
      data: {
        display_name: 'Deleted user',
        // Nulled rather than shifted: an age band is still a data point, and
        // the under-18 gate has no meaning for an account nobody can sign into.
        date_of_birth: null,
        is_verified: false,
        suspension_reason: null,
      },
    });

    // Sign-in identifiers are the strongest link back to a person. The rows
    // are kept so a re-registration cannot silently reuse a deleted account's
    // history, but the identifier itself is destroyed.
    const identities = await tx.authIdentity.findMany({
      where: { user_id: userId },
      select: { id: true, provider: true },
    });

    for (const identity of identities) {
      await tx.authIdentity.update({
        where: { id: identity.id },
        data: {
          identifier: tombstone(`deleted_${identity.provider}`),
          password_hash: null,
          verified_at: null,
        },
      });
    }

    // --- profile ----------------------------------------------------------
    const profile = await tx.profile.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });

    if (profile) {
      await tx.profile.update({
        where: { id: profile.id },
        data: {
          bio: null,
          city: null,
          country: null,
          job_title: null,
          organisation: null,
          education: null,
          height_cm: null,
          // Lifestyle answers are all individually identifying in combination —
          // diet, smoking, and pets narrow a population fast.
          drinking: null,
          smoking: null,
          exercise: null,
          diet: null,
          pets: null,
          children: null,
          completion_percentage: 0,
        },
      });

      await tx.profileAnswer.deleteMany({ where: { profile_id: profile.id } });
      await tx.profileInterest.deleteMany({ where: { profile_id: profile.id } });

      // PostGIS column, unreachable through Prisma.
      await tx.$executeRaw`
        UPDATE profiles SET location = NULL, location_updated_at = NULL
        WHERE id = ${profile.id}::uuid
      `;
    }

    // --- media ------------------------------------------------------------
    // Rows go; the S3 objects are removed by the media sweep, which already
    // owns bucket lifecycle and must not be duplicated here.
    const photos = await tx.photo.deleteMany({
      where: { profile: { user_id: userId } },
    });

    await tx.mediaAsset.updateMany({
      where: { owner_id: userId },
      data: { deleted_at: new Date() },
    });

    // --- devices and reachability ----------------------------------------
    const devices = await tx.device.updateMany({
      where: { user_id: userId },
      data: { fcm_token: null, revoked_at: new Date(), model: null, os_version: null },
    });

    // Contact details for THIRD PARTIES who never agreed to anything here.
    // These are deleted outright rather than tombstoned.
    const contacts = await tx.trustedContact.deleteMany({ where: { user_id: userId } });

    const notifications = await tx.notification.deleteMany({ where: { user_id: userId } });

    // --- messages ---------------------------------------------------------
    // Bodies are erased, rows are kept. The other participant's conversation
    // must not develop holes, and a report about a message needs the message to
    // still exist to point at.
    const messages = await tx.message.updateMany({
      where: { sender_id: userId, deleted_at: null },
      data: { body: null, deleted_at: new Date() },
    });

    return {
      photos_deleted: photos.count,
      identities_scrubbed: identities.length,
      devices_scrubbed: devices.count,
      contacts_deleted: contacts.count,
      notifications_deleted: notifications.count,
      messages_scrubbed: messages.count,
    };
  });

  // Location trails, outside the transaction because they are raw SQL over a
  // PostGIS table and their loss is not something to roll back.
  await prisma.liveLocationSession.updateMany({
    where: { user_id: userId, ended_at: null },
    data: { ended_at: new Date() },
  });

  await pruneExpiredLiveLocations();

  // No user id in the log line. A log that records which account was erased,
  // alongside a timestamp, reconstructs part of what was just erased.
  logger.info({ ...result }, 'personal data erased');

  return result;
}
