import { createServer, type Server as HttpServer } from 'node:http';
import { type Socket as ClientSocket, io as connect } from 'socket.io-client';

import { app } from '@/app';
import type { AuthTokens } from '@modules/auth/auth.types';
import { closeSocketServer, createSocketServer } from '@/realtime/socket.server';

/**
 * A real Socket.IO server on an ephemeral port, with real clients.
 *
 * Not mocked: the handshake, room membership, and disconnect handling are the
 * things most likely to be wrong, and every one of them lives in the transport
 * rather than in code a mock would exercise. Port 0 lets the OS pick, so suites
 * never collide over a fixed port.
 */

let httpServer: HttpServer | null = null;
let baseUrl = '';
const clients: ClientSocket[] = [];

export async function startTestSocketServer(): Promise<string> {
  httpServer = createServer(app);
  createSocketServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer?.listen(0, '127.0.0.1', resolve);
  });

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    throw new Error('test socket server did not bind a port');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;

  return baseUrl;
}

export async function stopTestSocketServer(): Promise<void> {
  // Clients first: disconnecting them after the server closes leaves sockets
  // half-open and jest reports the worker as failing to exit.
  for (const client of clients) {
    client.removeAllListeners();
    client.disconnect();
  }
  clients.length = 0;

  // The server's disconnect handlers are async — they write presence to Redis
  // and last_active_at to Postgres. Closing the database out from under them
  // produces errors after the suite has "finished", and jest reports the
  // worker as failing to exit.
  await settle();

  await closeSocketServer();

  if (httpServer) {
    const server = httpServer;
    httpServer = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/** Connects and resolves once the handshake succeeds, or rejects with its code. */
export function connectClient(
  tokens: AuthTokens | { access_token: string },
): Promise<ClientSocket> {
  return connectWithToken(tokens.access_token);
}

export function connectWithToken(token: string | undefined): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const client = connect(baseUrl, {
      auth: token === undefined ? {} : { token },
      // websocket only: the polling fallback makes a handshake failure arrive
      // as an HTTP error rather than a connect_error with the code on it.
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: 5000,
    });

    clients.push(client);

    client.on('connect', () => resolve(client));

    client.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      const failure = new Error(error.message) as Error & { code?: string };
      failure.code = error.data?.code;
      reject(failure);
    });
  });
}

/**
 * Resolves with the first payload for `event`, or rejects on timeout.
 *
 * Must be armed BEFORE the action that triggers the event: attaching the
 * listener afterwards races the emit, and the test passes or fails on timing
 * rather than on behaviour.
 */
export function nextEvent<TPayload = unknown>(
  client: ClientSocket,
  event: string,
  timeoutMs = 4000,
): Promise<TPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);

    function handler(payload: TPayload): void {
      clearTimeout(timer);
      client.off(event, handler);
      resolve(payload);
    }

    client.on(event, handler);
  });
}

/** Asserts an event does NOT arrive — for leak tests, which need the negative. */
export async function expectNoEvent(
  client: ClientSocket,
  event: string,
  windowMs = 600,
): Promise<void> {
  let received: unknown = null;

  const handler = (payload: unknown): void => {
    received = payload;
  };

  client.on(event, handler);

  await new Promise((resolve) => setTimeout(resolve, windowMs));

  client.off(event, handler);

  if (received !== null) {
    throw new Error(`expected no "${event}" but received ${JSON.stringify(received)}`);
  }
}

/**
 * Waits for the server to finish handling a disconnect.
 *
 * A client's disconnect event fires as soon as IT has torn down; the server's
 * handler runs independently and asynchronously. Asserting on presence
 * immediately after `disconnectClient` races that handler.
 */
export function settle(ms = 700): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function disconnectClient(client: ClientSocket): Promise<void> {
  return new Promise((resolve) => {
    if (!client.connected) {
      resolve();
      return;
    }
    client.on('disconnect', () => resolve());
    client.disconnect();
  });
}
