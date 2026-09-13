import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';

import { env, isProduction } from '@config/env';
import { logger } from '@utils/logger';
import { ERROR_CODES } from '@utils/error-codes';
import { CLIENT_EVENTS, CLIENT_EVENT_SCHEMAS, SERVER_EVENTS } from './events';
import { broadcastPresence, emitMessageRead, emitToUser, registerSocketServer } from './emit';
import {
  PRESENCE_HEARTBEAT_SECONDS,
  markOffline,
  markOnline,
  refresh,
  touchLastActive,
} from './presence';
import { markRead } from '@modules/chat/chat.service';
import { otherParticipantId } from './participants';
import { userRoom } from './rooms';
import { authenticateSocket } from './socket.auth';

/**
 * The Socket.IO server (spec §7, Batch 9).
 *
 * Realtime is a DELIVERY layer over the REST API, never a second write path.
 * Every state change still goes through a service that persists it; the socket
 * carries the news afterwards. That is why a dropped socket costs a refresh
 * rather than a message, and why the whole feature can be switched off without
 * the product losing correctness.
 */

let io: Server | null = null;

export function createSocketServer(httpServer: HttpServer): Server {
  if (io) {
    return io;
  }

  io = new Server(httpServer, {
    path: '/socket.io',
    // Same origins as the REST API. A socket that accepts origins the API
    // refuses is a hole around the CORS policy, not a convenience.
    cors: {
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
    // Sockets carry chat messages, not uploads: media goes to S3 by presigned
    // PUT. A small ceiling here costs nothing and bounds a trivial DoS.
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use((socket, next) => {
    authenticateSocket(socket)
      .then(() => next())
      .catch((error: Error) => next(error));
  });

  io.on('connection', (socket) => {
    void onConnection(socket);
  });

  registerSocketServer(io);

  logger.info({ path: '/socket.io' }, 'socket server started');

  return io;
}

async function onConnection(socket: Socket): Promise<void> {
  const user = socket.user;

  if (!user) {
    // Unreachable: the handshake middleware refuses anything without a user.
    socket.disconnect(true);
    return;
  }

  // REGISTERED FIRST, before any await.
  //
  // Socket.IO drops an incoming packet that has no listener yet. Every await
  // between the connection opening and this line is a window in which a client
  // that emits immediately on connect — which is exactly what a chat app does
  // when it reopens a thread — silently loses the event.
  registerHandlers(socket, user.id);

  // Refreshes the presence key before its TTL lapses. Without it a user reading
  // quietly for two minutes drops offline while still connected.
  const heartbeat = setInterval(() => {
    void refresh(user.id);
  }, PRESENCE_HEARTBEAT_SECONDS * 1000);

  // Node keeps the process alive for pending timers; without unref a graceful
  // shutdown waits on every connected socket's heartbeat.
  heartbeat.unref();

  // Every socket the user has open joins one room, so a message reaches their
  // phone and their tablet from a single emit.
  const ready = (async () => {
    await socket.join(userRoom(user.id));
    await markOnline(user.id, socket.id);
    await touchLastActive(user.id);
    await broadcastPresence(user.id, true, new Date());
  })();

  socket.on('disconnect', () => {
    clearInterval(heartbeat);

    void (async () => {
      // Waits for the connect sequence to finish before undoing it. A socket
      // that opens and closes within a few milliseconds — a flaky network, an
      // app backgrounded on launch — would otherwise have its markOnline land
      // AFTER its markOffline and leave a phantom "online" entry standing
      // until the TTL lapsed.
      await ready.catch(() => undefined);

      const wentOffline = await markOffline(user.id, socket.id);

      if (wentOffline) {
        const now = new Date();
        await touchLastActive(user.id, now.getTime());
        await broadcastPresence(user.id, false, now);
      }
    })();
  });

  await ready;

  if (!isProduction) {
    logger.debug({ user_id: user.id, socket_id: socket.id }, 'socket connected');
  }
}

/**
 * Validates an incoming payload before it reaches any logic.
 *
 * Socket payloads are as untrusted as request bodies and get the same
 * treatment: nothing unvalidated reaches a service (spec §4.10). A bad payload
 * answers with the same error vocabulary as REST rather than a thrown exception
 * that would take the connection down.
 */
function handle<TEvent extends keyof typeof CLIENT_EVENT_SCHEMAS>(
  socket: Socket,
  event: TEvent,
  handler: (payload: unknown) => Promise<void> | void,
): void {
  // Cast because Socket.IO types `on` against a reserved-event map; these are
  // application events whose payloads the Zod schema below validates.
  socket.on(event as string, (raw: unknown) => {
    const parsed = CLIENT_EVENT_SCHEMAS[event].safeParse(raw ?? {});

    if (!parsed.success) {
      socket.emit(SERVER_EVENTS.ERROR, {
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Invalid payload for ${event}.`,
      });
      return;
    }

    void (async () => {
      try {
        await handler(parsed.data);
      } catch (error) {
        logger.error({ err: error, event }, 'socket handler failed');
        socket.emit(SERVER_EVENTS.ERROR, {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Something went wrong.',
        });
      }
    })();
  });
}

/**
 * Typing goes straight to the other participant's USER room, not a shared
 * conversation room.
 *
 * A conversation room would have to be joined first, which makes delivery
 * depend on a join the sender cannot observe — the recipient silently misses
 * indicators until they happen to have opened the thread. Every conversation
 * has exactly two people (decision #11), so addressing the other one directly
 * is both simpler and impossible to race.
 *
 * Returning null when the caller is not a participant is also the access check:
 * nothing is emitted for a conversation you are not in, so a client cannot
 * watch strangers type by guessing an id.
 */
async function typingRecipient(userId: string, conversationId: string): Promise<string | null> {
  return otherParticipantId(conversationId, userId);
}

function registerHandlers(socket: Socket, userId: string): void {
  const typing = (isTyping: boolean) => async (payload: unknown) => {
    const { conversation_id } = payload as { conversation_id: string };
    const recipient = await typingRecipient(userId, conversation_id);

    if (!recipient) {
      return;
    }

    emitToUser(recipient, SERVER_EVENTS.TYPING, {
      conversation_id,
      user_id: userId,
      is_typing: isTyping,
    });
  };

  handle(socket, CLIENT_EVENTS.TYPING_START, typing(true));
  handle(socket, CLIENT_EVENTS.TYPING_STOP, typing(false));

  handle(socket, CLIENT_EVENTS.CONVERSATION_READ, async (payload) => {
    const { conversation_id } = payload as { conversation_id: string };

    // PERSIST FIRST. The socket path writes through the same service the REST
    // endpoint uses, so read state cannot diverge depending on which one the
    // client happened to call.
    const result = await markRead(userId, conversation_id);
    const other = await otherParticipantId(conversation_id, userId);

    if (other) {
      emitMessageRead(other, {
        conversation_id,
        reader_id: userId,
        read_at: result.last_read_at,
      });
    }
  });

  handle(socket, CLIENT_EVENTS.PRESENCE_PING, async () => {
    await refresh(userId);
    await touchLastActive(userId);
  });
}

export async function closeSocketServer(): Promise<void> {
  if (!io) {
    return;
  }

  const closing = io;
  io = null;
  registerSocketServer(null);

  await new Promise<void>((resolve) => {
    closing.close(() => resolve());
  });

  logger.info('socket server closed');
}

export function getSocketServer(): Server | null {
  return io;
}
