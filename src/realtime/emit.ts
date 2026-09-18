import type { Server } from 'socket.io';

import { MatchStatus, prisma } from '@/db/prisma';
import { getBlockedUserIds } from '@modules/safety/block.service';
import { logger } from '@utils/logger';
import {
  type ConversationUpdatedPayload,
  type MatchNewPayload,
  type MessageNewPayload,
  type PresenceUpdatePayload,
  SERVER_EVENTS,
  type CallIncomingPayload,
} from './events';
import { onlineStatusFor } from './presence';
import { conversationRoom, deviceRoom, userRoom } from './rooms';

/**
 * Server-to-client emitters (spec §7, Batch 9).
 *
 * THE DURABILITY RULE: persist first, then emit. Every function here is called
 * AFTER the transaction that wrote the thing it describes has committed. None
 * of them may be called from inside a transaction — a rolled-back transaction
 * would have already told the client about a message that does not exist.
 *
 * Every emit is best-effort. A failure is logged and swallowed, because the
 * REST write already succeeded and failing the request now would tell the user
 * their message was not sent when it was.
 */

let io: Server | null = null;

/** Called once by the socket server. Emitters are inert until then. */
export function registerSocketServer(server: Server | null): void {
  io = server;
}

/**
 * No socket server means no realtime, not an error.
 *
 * Tests exercise REST without a socket server, and a worker process has none at
 * all. Both must be able to write to the database.
 */
function emitter(): Server | null {
  return io;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  try {
    emitter()?.to(userRoom(userId)).emit(event, payload);
  } catch (error) {
    logger.error({ err: error, event, user_id: userId }, 'socket emit failed');
  }
}

export function emitToConversation(
  conversationId: string,
  event: string,
  payload: unknown,
  exceptSocketId?: string,
): void {
  try {
    const target = emitter()?.to(conversationRoom(conversationId));

    if (!target) {
      return;
    }

    if (exceptSocketId) {
      // The sender already knows they are typing.
      emitter()?.except(exceptSocketId).to(conversationRoom(conversationId)).emit(event, payload);
      return;
    }

    target.emit(event, payload);
  } catch (error) {
    logger.error({ err: error, event, conversation_id: conversationId }, 'socket emit failed');
  }
}

/**
 * Closes the live connections of a device that was just signed out.
 * Reconnecting is refused at the handshake, like its next request.
 */
export function disconnectDevice(userId: string, deviceId: string): void {
  try {
    emitter()?.in(deviceRoom(userId, deviceId)).disconnectSockets(true);
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'socket disconnect failed');
  }
}

export function emitMessage(recipientId: string, message: MessageNewPayload): void {
  emitToUser(recipientId, SERVER_EVENTS.MESSAGE_NEW, message);
}

export function emitConversationUpdated(userId: string, payload: ConversationUpdatedPayload): void {
  emitToUser(userId, SERVER_EVENTS.CONVERSATION_UPDATED, payload);
}

/**
 * Typing started or stopped. Addressed to the other participant's own room, so
 * delivery never depends on a conversation join the sender cannot observe.
 */
export function emitTyping(
  recipientId: string,
  payload: { conversation_id: string; user_id: string; is_typing: boolean },
): void {
  emitToUser(recipientId, SERVER_EVENTS.TYPING, payload);
}

export function emitMessageRead(
  recipientId: string,
  payload: { conversation_id: string; reader_id: string; read_at: string },
): void {
  emitToUser(recipientId, SERVER_EVENTS.MESSAGE_READ, payload);
}

export function emitMatch(userId: string, payload: MatchNewPayload): void {
  emitToUser(userId, SERVER_EVENTS.MATCH_NEW, payload);
}

export function emitEntitlementsUpdated(userId: string, tier: string): void {
  emitToUser(userId, SERVER_EVENTS.ENTITLEMENTS_UPDATED, { tier });
}

/**
 * Call signalling (Batch 14).
 *
 * Named emitters rather than raw `emitToUser(id, 'call:incoming', …)` calls in
 * the service, for the same reason the message emitters exist: the event name
 * and its payload shape stay next to each other and next to the schema that
 * documents them. A typo'd string in a service is an event no client ever
 * receives, and nothing fails.
 */
export function emitCallIncoming(userId: string, payload: CallIncomingPayload): void {
  emitToUser(userId, SERVER_EVENTS.CALL_INCOMING, payload);
}

export function emitCallAnswered(userId: string, callId: string): void {
  emitToUser(userId, SERVER_EVENTS.CALL_ANSWERED, { call_id: callId });
}

export function emitCallDeclined(userId: string, callId: string): void {
  emitToUser(userId, SERVER_EVENTS.CALL_DECLINED, { call_id: callId });
}

export function emitCallEnded(
  userId: string,
  callId: string,
  durationSeconds: number | null,
): void {
  emitToUser(userId, SERVER_EVENTS.CALL_ENDED, {
    call_id: callId,
    duration_seconds: durationSeconds,
  });
}

/**
 * Announces presence to everyone with an ACTIVE MATCH with this user, minus
 * anyone on either side of a block.
 *
 * Presence is a leak surface: broadcasting it widely would tell strangers when
 * someone is at their phone, and telling a blocked person would hand them a
 * live activity feed of the person who blocked them. The match requirement is
 * what keeps it to people who already talk.
 *
 * Nothing is sent about someone who hides their activity (settings
 * `show_last_active`). Every list already shows them as neither online nor
 * recently active, and a live event would hand that straight back.
 */
export async function broadcastPresence(
  userId: string,
  isOnline: boolean,
  lastActiveAt: Date,
): Promise<void> {
  if (!emitter()) {
    return;
  }

  try {
    if (!(await showsActivity(userId))) {
      return;
    }

    await sendPresence({
      user_id: userId,
      is_online: isOnline,
      last_active_at: lastActiveAt.toISOString(),
    });
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'presence broadcast failed');
  }
}

/**
 * Tells someone's matches straight away when they start or stop showing their
 * activity. Without it, a chat that was open when they turned it off would
 * keep showing them online until the screen was reloaded.
 */
export async function broadcastActivityVisibility(userId: string, shown: boolean): Promise<void> {
  if (!emitter()) {
    return;
  }

  try {
    if (!shown) {
      await sendPresence({ user_id: userId, is_online: false, last_active_at: null });
      return;
    }

    const [online, user] = await Promise.all([
      onlineStatusFor([userId]),
      prisma.user.findUnique({ where: { id: userId }, select: { last_active_at: true } }),
    ]);

    if (user) {
      await sendPresence({
        user_id: userId,
        is_online: online.has(userId),
        last_active_at: user.last_active_at.toISOString(),
      });
    }
  } catch (error) {
    logger.error({ err: error, user_id: userId }, 'presence broadcast failed');
  }
}

/** Settings rows are created on first use, so no row means the default: shown. */
async function showsActivity(userId: string): Promise<boolean> {
  const settings = await prisma.userSettings.findUnique({
    where: { user_id: userId },
    select: { show_last_active: true },
  });

  return settings?.show_last_active ?? true;
}

async function sendPresence(payload: PresenceUpdatePayload): Promise<void> {
  const userId = payload.user_id;
  const [matches, blockedUserIds] = await Promise.all([
    prisma.match.findMany({
      where: {
        status: MatchStatus.active,
        expires_at: { gt: new Date() },
        OR: [{ user_a_id: userId }, { user_b_id: userId }],
      },
      select: { user_a_id: true, user_b_id: true },
    }),
    getBlockedUserIds(userId),
  ]);

  const blocked = new Set(blockedUserIds);
  const audience = new Set<string>();

  for (const match of matches) {
    const other = match.user_a_id === userId ? match.user_b_id : match.user_a_id;
    if (!blocked.has(other)) {
      audience.add(other);
    }
  }

  for (const recipient of audience) {
    emitToUser(recipient, SERVER_EVENTS.PRESENCE_UPDATE, payload);
  }
}
