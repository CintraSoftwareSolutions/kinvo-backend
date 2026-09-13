import type { Socket } from 'socket.io';

import { UserStatus, prisma } from '@/db/prisma';
import { verifyAccessToken } from '@modules/auth/token.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

/**
 * Handshake authentication (spec §7, Batch 9).
 *
 * The same rules as the REST middleware, for the same reasons:
 *
 *  - The user is LOADED FROM THE DATABASE, never trusted from token claims. A
 *    socket can stay open for hours; a suspension inside that window has to
 *    take effect, and it cannot if identity came from a claim baked in at
 *    sign-in.
 *  - AUTH_TOKEN_EXPIRED stays distinct from AUTH_TOKEN_INVALID. The app
 *    refreshes and reconnects on the first and signs the user out on the
 *    second. Collapsing them makes every expiry look like a session ending.
 *
 * Un-onboarded accounts are refused outright: they have no matches and no
 * conversations, so there is nothing for them to receive, and social or phone
 * signups have not passed the under-18 check yet.
 */

export interface SocketUser {
  id: string;
  role: string;
}

declare module 'socket.io' {
  interface Socket {
    user?: SocketUser;
  }
}

function tokenFrom(socket: Socket): string | null {
  // `auth` is the documented place and what the Flutter client uses. The
  // Authorization header is accepted too because some proxies and test tools
  // cannot set handshake auth.
  const fromAuth = socket.handshake.auth?.token;

  if (typeof fromAuth === 'string' && fromAuth.trim()) {
    return fromAuth.trim();
  }

  const header = socket.handshake.headers.authorization;

  if (typeof header === 'string') {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value?.trim()) {
      return value.trim();
    }
  }

  return null;
}

/** Socket.IO surfaces `error.data` to the client, so the code survives the trip. */
function handshakeError(code: string, message: string): Error {
  const error = new Error(message) as Error & { data?: { code: string } };
  error.data = { code };
  return error;
}

export async function authenticateSocket(socket: Socket): Promise<void> {
  const token = tokenFrom(socket);

  if (!token) {
    throw handshakeError(ERROR_CODES.AUTH_REQUIRED, 'Sign in to connect.');
  }

  let userId: string;

  try {
    userId = verifyAccessToken(token).sub;
  } catch (error) {
    // verifyAccessToken has ALREADY mapped jsonwebtoken's errors to the right
    // code, so catching TokenExpiredError here would never match and every
    // routine expiry would read as an invalid session — which signs the user
    // out instead of refreshing. Reuse the mapping rather than repeating it.
    if (error instanceof ApiError) {
      throw handshakeError(error.code, error.message);
    }
    throw handshakeError(ERROR_CODES.AUTH_TOKEN_INVALID, 'That session is not valid.');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true, deleted_at: true, onboarded_at: true },
  });

  if (!user || user.deleted_at) {
    throw handshakeError(ERROR_CODES.AUTH_TOKEN_INVALID, 'That session is not valid.');
  }

  if (user.status === UserStatus.suspended) {
    throw handshakeError(ERROR_CODES.ACCOUNT_SUSPENDED, 'Your account has been suspended.');
  }

  if (!user.onboarded_at) {
    throw handshakeError(ERROR_CODES.ONBOARDING_INCOMPLETE, 'Finish setting up your profile.');
  }

  socket.user = { id: user.id, role: user.role };
}
