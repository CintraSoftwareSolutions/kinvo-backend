import type { Socket } from 'socket.io';

import { UserStatus, prisma } from '@/db/prisma';
import { verifyAccessToken } from '@modules/auth/token.service';
import type { AccessTokenPayload } from '@modules/auth/auth.types';
import { isDeviceSignedOut } from '@modules/settings/devices.service';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';

export interface SocketUser {
  id: string;
  role: string;
  device_id: string | null;
}

declare module 'socket.io' {
  interface Socket {
    user?: SocketUser;
  }
}

function tokenFrom(socket: Socket): string | null {
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

  let payload: AccessTokenPayload;

  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    if (error instanceof ApiError) {
      throw handshakeError(error.code, error.message);
    }
    throw handshakeError(ERROR_CODES.AUTH_TOKEN_INVALID, 'That session is not valid.');
  }

  const [user, deviceSignedOut] = await Promise.all([
    prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true, deleted_at: true, onboarded_at: true },
    }),
    payload.did ? isDeviceSignedOut(payload.sub, payload.did) : false,
  ]);

  if (!user || user.deleted_at || deviceSignedOut) {
    throw handshakeError(ERROR_CODES.AUTH_TOKEN_INVALID, 'That session is not valid.');
  }

  if (user.status === UserStatus.suspended) {
    throw handshakeError(ERROR_CODES.ACCOUNT_SUSPENDED, 'Your account has been suspended.');
  }

  if (!user.onboarded_at) {
    throw handshakeError(ERROR_CODES.ONBOARDING_INCOMPLETE, 'Finish setting up your profile.');
  }

  socket.user = { id: user.id, role: user.role, device_id: payload.did ?? null };
}
