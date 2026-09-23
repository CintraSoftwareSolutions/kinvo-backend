import { MatchStatus, MediaKind, type MessageType, type Mode, Prisma, prisma } from '@/db/prisma';
import { consumeQuota, refundQuota } from '@modules/entitlements/quota.service';
import { claimAsset } from '@modules/media/media.service';
import { type BucketName, presignDownload } from '@/providers/s3.provider';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { getBlockedUserIds, isBlockedBetween } from '@modules/safety/block.service';
import { isExpired, isPairReachable, otherUserId } from '@modules/matches/matches.service';
import { scanSubject } from '@modules/moderation/moderation.service';
import { notify } from '@modules/notifications/notifications.service';
import { otherParticipantId } from '@/realtime/participants';
import { onlineStatusFor } from '@/realtime/presence';
import { ApiError } from '@utils/api-error';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { ERROR_CODES } from '@utils/error-codes';
import { emitConversationUpdated, emitMessage, emitMessageRead, emitTyping } from '@/realtime/emit';
import type { SendMessageBody } from './chat.schema';

/**
 * Conversations and messages (spec §5.4, Batch 8).
 *
 * A conversation belongs to exactly one match and inherits its mode, which
 * never changes. Exactly two participants, always (decision #11) — Study Buddy
 * groups are out of scope for v1.
 *
 * Users cannot message before matching (decision #5), so there is no endpoint
 * that creates a conversation. One is created with its match and lives and dies
 * with it.
 */

export interface MessageView {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: MessageType;
  body: string | null;
  media_url: string | null;
  venue_id: string | null;
  duration_ms: number | null;
  moderation_flagged: boolean;
  moderation_overridden: boolean;
  read_at: string | null;
  created_at: string;
}

export interface ConversationView {
  id: string;
  match_id: string;
  mode: Mode;
  /** Immutable header state the app renders without a second call (spec §4.7). */
  user: UserCompact;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  is_archived: boolean;
  is_muted: boolean;
  /** False when the pair is blocked, or the match expired or was unmatched. */
  is_writable: boolean;
  match_expires_at: string;
}

const CONVERSATION_INCLUDE = {
  states: true,
  match: {
    select: {
      id: true,
      user_a_id: true,
      user_b_id: true,
      status: true,
      expires_at: true,
      user_a: { select: { ...USER_COMPACT_SELECT, deleted_at: true, status: true } },
      user_b: { select: { ...USER_COMPACT_SELECT, deleted_at: true, status: true } },
    },
  },
} satisfies Prisma.ConversationInclude;

type ConversationWithRelations = Prisma.ConversationGetPayload<{
  include: typeof CONVERSATION_INCLUDE;
}>;

/**
 * Loads a conversation the viewer participates in, or throws 404.
 *
 * Participation is checked against the MATCH, not the conversation-state rows:
 * a state row is bookkeeping and could in principle be missing, while the match
 * is the authority on who is in this conversation.
 */
async function loadParticipating(
  viewerId: string,
  conversationId: string,
): Promise<ConversationWithRelations> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      match: {
        OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
      },
    },
    include: CONVERSATION_INCLUDE,
  });

  if (!conversation) {
    throw ApiError.notFound();
  }

  return conversation;
}

function participantFor(conversation: ConversationWithRelations, viewerId: string) {
  return conversation.match.user_a_id === viewerId
    ? conversation.match.user_b
    : conversation.match.user_a;
}

function toConversationView(
  conversation: ConversationWithRelations,
  viewerId: string,
  photoUrl: string | null,
  isBlocked: boolean,
  isOnline: boolean,
  now = new Date(),
): ConversationView {
  const other = participantFor(conversation, viewerId);
  const state = conversation.states.find((row) => row.user_id === viewerId);

  return {
    id: conversation.id,
    match_id: conversation.match_id,
    mode: conversation.mode,
    user: toUserCompact(other, photoUrl, isOnline),
    last_message_at: conversation.last_message_at?.toISOString() ?? null,
    last_message_preview: conversation.last_message_preview,
    unread_count: state?.unread_count ?? 0,
    is_archived: state?.is_archived ?? false,
    is_muted: state?.is_muted ?? false,
    is_writable:
      !isBlocked &&
      conversation.match.status === MatchStatus.active &&
      !isExpired(conversation.match, now),
    match_expires_at: conversation.match.expires_at.toISOString(),
  };
}

export async function listConversations(
  viewerId: string,
  options: { limit: number; cursor?: string; archived?: boolean; mode?: Mode },
) {
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const archived = options.archived ?? false;

  const rows = await prisma.conversation.findMany({
    where: {
      match: {
        OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
        status: { not: MatchStatus.unmatched },
      },
      ...(options.mode ? { mode: options.mode } : {}),
      states: { some: { user_id: viewerId, is_archived: archived } },
      ...(after ? { updated_at: { lt: new Date(String(after.k)) } } : {}),
    },
    include: CONVERSATION_INCLUDE,
    // Ordered by activity, not creation: a conversation that just received a
    // message belongs at the top. `updated_at` moves with every send.
    orderBy: { updated_at: 'desc' },
    take: options.limit + 1,
  });

  const visible = rows.filter((conversation) => {
    const other = participantFor(conversation, viewerId);
    return other.deleted_at === null && other.status === 'active';
  });

  const page = paginate(visible, options.limit, (conversation) => ({
    k: conversation.updated_at.toISOString(),
    id: conversation.id,
  }));

  const otherIds = page.items.map((conversation) => participantFor(conversation, viewerId).id);
  const [photoUrls, blockedUserIds, online] = await Promise.all([
    getPrimaryPhotoUrlsFor(otherIds),
    getBlockedUserIds(viewerId),
    onlineStatusFor(otherIds),
  ]);

  const blocked = new Set(blockedUserIds);
  const now = new Date();

  return {
    conversations: page.items.map((conversation) => {
      const other = participantFor(conversation, viewerId);
      return toConversationView(
        conversation,
        viewerId,
        photoUrls.get(other.id) ?? null,
        blocked.has(other.id),
        online.has(other.id),
        now,
      );
    }),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export async function getConversation(
  viewerId: string,
  conversationId: string,
): Promise<ConversationView> {
  const conversation = await loadParticipating(viewerId, conversationId);
  const other = participantFor(conversation, viewerId);

  if (other.deleted_at !== null || other.status !== 'active') {
    throw ApiError.notFound();
  }

  const [photoUrls, blocked, online] = await Promise.all([
    getPrimaryPhotoUrlsFor([other.id]),
    isBlockedBetween(viewerId, other.id),
    onlineStatusFor([other.id]),
  ]);

  return toConversationView(
    conversation,
    viewerId,
    photoUrls.get(other.id) ?? null,
    blocked,
    online.has(other.id),
  );
}

async function toMessageView(message: {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: MessageType;
  body: string | null;
  venue_id: string | null;
  duration_ms: number | null;
  moderation_flagged: boolean;
  moderation_overridden: boolean;
  read_at: Date | null;
  created_at: Date;
  media_asset: { s3_bucket: string; s3_key: string } | null;
}): Promise<MessageView> {
  return {
    id: message.id,
    conversation_id: message.conversation_id,
    sender_id: message.sender_id,
    type: message.type,
    body: message.body,
    // Both buckets are private, so every media URL is presigned on read and
    // time-limited. Nothing is ever stored as a public URL.
    media_url: message.media_asset
      ? await presignDownload({
          bucket: message.media_asset.s3_bucket as BucketName,
          key: message.media_asset.s3_key,
        })
      : null,
    venue_id: message.venue_id,
    duration_ms: message.duration_ms,
    moderation_flagged: message.moderation_flagged,
    moderation_overridden: message.moderation_overridden,
    read_at: message.read_at?.toISOString() ?? null,
    created_at: message.created_at.toISOString(),
  };
}

const MESSAGE_SELECT = {
  id: true,
  conversation_id: true,
  sender_id: true,
  type: true,
  body: true,
  venue_id: true,
  duration_ms: true,
  moderation_flagged: true,
  moderation_overridden: true,
  read_at: true,
  created_at: true,
  media_asset: { select: { s3_bucket: true, s3_key: true } },
} satisfies Prisma.MessageSelect;

/**
 * Message history, NEWEST FIRST, cursor walking backwards into the past
 * (spec §4.5).
 *
 * This is the opposite direction to every other list in the API, and it is
 * deliberate: a chat opens at the bottom, so the first page must be the most
 * recent messages and "next page" must mean older.
 */
export async function listMessages(
  viewerId: string,
  conversationId: string,
  options: { limit: number; cursor?: string },
) {
  // A blocked pair's history stays READABLE (see DECISIONS.md §1.2e). Only
  // sending is refused, so there is no visibility check beyond participation.
  await loadParticipating(viewerId, conversationId);

  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.message.findMany({
    where: {
      conversation_id: conversationId,
      deleted_at: null,
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
    select: MESSAGE_SELECT,
  });

  const page = paginate(rows, options.limit, (message) => ({
    k: message.created_at.toISOString(),
    id: message.id,
  }));

  return {
    messages: await Promise.all(page.items.map(toMessageView)),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

/**
 * Why a conversation is closed, if it is.
 *
 * Every reason answers the SAME error. "They blocked you", "they unmatched
 * you", and "the match expired" are different facts, and telling them apart
 * would let someone confirm a block by elimination — the same leak a 403 on a
 * blocked profile would cause (spec §4.4, §5.5).
 */
async function assertWritable(
  conversation: ConversationWithRelations,
  viewerId: string,
): Promise<void> {
  const other = participantFor(conversation, viewerId);

  // The rule itself lives in matches.service, because calling asks the same
  // question and a second copy of it would eventually stop matching this one.
  if (await isPairReachable(conversation.match, viewerId, other)) {
    return;
  }

  throw new ApiError(ERROR_CODES.FORBIDDEN, 'This conversation is closed.', {
    is_writable: false,
  });
}

const MEDIA_KIND_FOR: Partial<Record<MessageType, MediaKind>> = {
  image: MediaKind.chat_image,
  video: MediaKind.chat_video,
  voice_note: MediaKind.voice_note,
};

function previewFor(type: MessageType, body: string | null): string {
  switch (type) {
    case 'text':
      return (body ?? '').slice(0, 200);
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'voice_note':
      return 'Voice note';
    case 'venue_card':
      return 'Suggested a place';
    default:
      return '';
  }
}

/**
 * The message this token already made, if it made one.
 *
 * The check and the insert are not one operation, so two taps in flight at
 * once can both miss it; the partial unique index is what actually stops the
 * second, and the catch below turns that into this same answer. This lookup
 * is the common case — a retry seconds later — answered without touching
 * quota.
 */
async function findByClientToken(
  viewerId: string,
  conversationId: string,
  clientToken: string | undefined,
): Promise<MessageView | null> {
  if (!clientToken) {
    return null;
  }

  const existing = await prisma.message.findFirst({
    where: {
      conversation_id: conversationId,
      sender_id: viewerId,
      client_token: clientToken,
      deleted_at: null,
    },
    select: MESSAGE_SELECT,
  });

  return existing ? toMessageView(existing) : null;
}

export async function sendMessage(
  viewerId: string,
  conversationId: string,
  input: SendMessageBody,
): Promise<MessageView> {
  const conversation = await loadParticipating(viewerId, conversationId);
  await assertWritable(conversation, viewerId);

  // Before anything is claimed or spent. A send that timed out has usually
  // arrived, and the app trying again must cost neither a second row nor a
  // message from the day's allowance.
  const alreadySent = await findByClientToken(viewerId, conversationId, input.client_token);
  if (alreadySent) {
    return alreadySent;
  }

  const recipientId = otherUserId(conversation.match, viewerId);

  // Media is resolved BEFORE quota is spent: claimAsset checks ownership,
  // completion, and kind, and a failure there must not cost the user a message.
  let mediaAssetId: string | null = null;
  const expectedKind = MEDIA_KIND_FOR[input.type];

  if (expectedKind) {
    if (!input.media_asset_id) {
      throw ApiError.validation({ media_asset_id: ['This message type needs an upload.'] });
    }

    const claimed = await claimAsset({
      userId: viewerId,
      assetId: input.media_asset_id,
      expectedKind,
    });

    mediaAssetId = claimed.id;
  }

  if (input.type === 'venue_card' && !input.venue_id) {
    throw ApiError.validation({ venue_id: ['A venue card needs a venue.'] });
  }

  // Consumed before the write and refunded below if it fails, for the same
  // reason swiping does it: Redis and Postgres cannot commit together.
  await consumeQuota(viewerId, 'messages');

  try {
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversation_id: conversationId,
          sender_id: viewerId,
          type: input.type,
          body: input.body ?? null,
          media_asset_id: mediaAssetId,
          venue_id: input.venue_id ?? null,
          duration_ms: input.duration_ms ?? null,
          // spec §5.4: "review before you send" is advisory. When the user
          // pushes past a warning we record it — that is exactly what the
          // moderation team needs to see later. Batch 10 sets the flag itself.
          moderation_overridden: input.moderation_overridden ?? false,
          client_token: input.client_token ?? null,
        },
        select: MESSAGE_SELECT,
      });

      const now = created.created_at;

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          last_message_at: now,
          last_message_preview: previewFor(input.type, input.body ?? null),
          updated_at: now,
        },
      });

      // Only the RECIPIENT's badge moves. Incrementing both would make the
      // sender's own message show as unread to themselves.
      await tx.conversationState.updateMany({
        where: { conversation_id: conversationId, user_id: recipientId },
        data: { unread_count: { increment: 1 }, is_archived: false },
      });

      // The sender has by definition read their own message.
      await tx.conversationState.updateMany({
        where: { conversation_id: conversationId, user_id: viewerId },
        data: { last_read_at: now, unread_count: 0 },
      });

      return created;
    });

    // POST-HOC SCAN (spec §7, Batch 10). After the write and outside the
    // transaction: moderation is advisory, so a scan failing must never cost a
    // user their message. A pre-send check is offered separately at
    // POST /moderation/check — this catches what was sent regardless of whether
    // the client bothered to call it, including anything sent while the
    // provider was down.
    let flagged = message.moderation_flagged;

    if (input.type === 'text' && input.body) {
      const severity = await scanSubject({
        userId: viewerId,
        subjectType: 'message',
        subjectId: message.id,
        content: input.body,
      });

      if (severity !== 'none') {
        await prisma.message.update({
          where: { id: message.id },
          data: { moderation_flagged: true },
        });
        flagged = true;
      }
    }

    // Built from what was just stored, flag included. The row read before the
    // scan still says unflagged, and the recipient's app shows its scam warning
    // from this field on the message it is sent live.
    const view = await toMessageView({ ...message, moderation_flagged: flagged });

    // PERSIST FIRST, THEN EMIT (spec §7). This runs after the transaction has
    // committed, so the socket can never announce a message that a rollback
    // erased. The emit is best-effort: the write already succeeded, and failing
    // the request now would tell the user their message did not send when it
    // did.
    emitMessage(recipientId, view);

    // Sending ends typing, and the published contract says the server says so:
    // clients are told they need not send typing:stop themselves. A client
    // that trusted that and was never told would show "typing…" under a
    // message that has already arrived.
    emitTyping(recipientId, {
      conversation_id: conversationId,
      user_id: viewerId,
      is_typing: false,
    });

    const recipientState = await prisma.conversationState.findFirst({
      where: { conversation_id: conversationId, user_id: recipientId },
      select: { unread_count: true, is_muted: true },
    });

    emitConversationUpdated(recipientId, {
      conversation_id: conversationId,
      unread_count: recipientState?.unread_count ?? 0,
      last_message_at: view.created_at,
      last_message_preview: previewFor(input.type, input.body ?? null),
    });

    const sender = participantFor(conversation, recipientId);

    // Muting a conversation is the recipient saying "not about this one". The
    // message still arrives and still counts as unread; it just announces
    // nothing — no push, and nothing in the notifications feed.
    if (!recipientState?.is_muted) {
      await notify({
        userId: recipientId,
        category: 'new_message',
        title: sender.display_name,
        // The preview, not the body: a media message has no text, and a very
        // long message should not arrive as a wall of text in a banner.
        body: previewFor(input.type, input.body ?? null),
        data: { conversation_id: conversationId, match_id: conversation.match_id },
      });
    }

    return view;
  } catch (error) {
    // Never charge for a message the database rejected.
    await refundQuota(viewerId, 'messages');

    // Two sends of the same token at once: one wrote the row, the index
    // refused this one. The caller asked for that message to exist, and it
    // does, so hand it back rather than reporting a failure for something
    // that succeeded.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await findByClientToken(viewerId, conversationId, input.client_token);
      if (raced) {
        return raced;
      }
    }

    throw error;
  }
}

export interface ReadResult {
  conversation_id: string;
  unread_count: number;
  last_read_at: string;
}

/** Marks everything up to now read, and clears the badge. */
export async function markRead(viewerId: string, conversationId: string): Promise<ReadResult> {
  await loadParticipating(viewerId, conversationId);

  const now = new Date();

  await prisma.$transaction([
    prisma.conversationState.updateMany({
      where: { conversation_id: conversationId, user_id: viewerId },
      data: { last_read_at: now, unread_count: 0 },
    }),
    // The feed told the viewer about these messages. Once the conversation is
    // read, so are those notifications — otherwise the notification badge, and
    // the app icon badge pushed from it, counts messages already read and only
    // ever grows.
    prisma.notification.updateMany({
      where: {
        user_id: viewerId,
        category: 'new_message',
        read_at: null,
        data: { path: ['conversation_id'], equals: conversationId },
      },
      data: { read_at: now },
    }),
    // Read receipts are per message so the sender can render ticks. Scoped to
    // messages the viewer did NOT send: marking your own as read is meaningless
    // and would show the wrong tick to the other person.
    prisma.message.updateMany({
      where: {
        conversation_id: conversationId,
        sender_id: { not: viewerId },
        read_at: null,
      },
      data: { read_at: now },
    }),
  ]);

  // After the write, so a failed update cannot move the other person's ticks.
  const other = await otherParticipantId(conversationId, viewerId);

  if (other) {
    emitMessageRead(other, {
      conversation_id: conversationId,
      reader_id: viewerId,
      read_at: now.toISOString(),
    });
  }

  return {
    conversation_id: conversationId,
    unread_count: 0,
    last_read_at: now.toISOString(),
  };
}

export async function updateConversationState(
  viewerId: string,
  conversationId: string,
  input: { is_archived?: boolean; is_muted?: boolean },
): Promise<ConversationView> {
  await loadParticipating(viewerId, conversationId);

  await prisma.conversationState.updateMany({
    where: { conversation_id: conversationId, user_id: viewerId },
    data: {
      ...(input.is_archived === undefined ? {} : { is_archived: input.is_archived }),
      ...(input.is_muted === undefined ? {} : { is_muted: input.is_muted }),
    },
  });

  return getConversation(viewerId, conversationId);
}

/** The app-badge number: unread across every conversation, in one query. */
export async function unreadTotal(viewerId: string): Promise<{ unread_count: number }> {
  const result = await prisma.conversationState.aggregate({
    where: {
      user_id: viewerId,
      conversation: {
        match: {
          OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }],
          status: MatchStatus.active,
        },
      },
    },
    _sum: { unread_count: true },
  });

  return { unread_count: result._sum.unread_count ?? 0 };
}
