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

let io: Server | null = null;

export function registerSocketServer(server: Server | null): void {
  io = server;
}

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
