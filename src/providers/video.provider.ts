import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';

import { env, thirdPartyIntegrationsRequired } from '@config/env';
import { logger } from '@utils/logger';

export const VIDEO_TOKEN_TTL_SECONDS = 60 * 60;

export interface VideoToken {
  token: string;
  room_name: string;
  identity: string;
  server_url: string | null;
  expires_at: Date;
}

export interface VideoRoomEvent {
  type: 'room-ended' | 'other';
  roomName: string;
}

export interface VideoProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  roomNameFor(callId: string): string;
  issueToken(options: { roomName: string; userId: string }): Promise<VideoToken>;
  readWebhook(options: { body: string; authorization?: string }): Promise<VideoRoomEvent | null>;
  closeRoom(roomName: string): Promise<void>;
}

function hasCredentials(): boolean {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

function roomName(callId: string): string {
  return `kinvo-call-${callId}`;
}

function managementUrl(url: string): string {
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

let roomService: RoomServiceClient | null = null;

function rooms(): RoomServiceClient {
  roomService ??= new RoomServiceClient(
    managementUrl(env.LIVEKIT_URL!),
    env.LIVEKIT_API_KEY!,
    env.LIVEKIT_API_SECRET!,
  );

  return roomService;
}

let webhooks: WebhookReceiver | null = null;

function receiver(): WebhookReceiver {
  webhooks ??= new WebhookReceiver(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!);
  return webhooks;
}

const liveKitVideoProvider: VideoProvider = {
  name: 'livekit',
  isConfigured: true,

  roomNameFor: roomName,

  async issueToken({ roomName: room, userId }) {
    const token = new AccessToken(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!, {
      // The identity is our user id, not a name or an email. LiveKit shows it
      // to the other participant in the room, so it must not carry PII.
      identity: userId,
      ttl: VIDEO_TOKEN_TTL_SECONDS,
    });

    token.addGrant({
      roomJoin: true,
      // Scoped to ONE room. Without `room`, `roomJoin` is a grant to every room
      // on the project.
      room,
      canPublish: true,
      canSubscribe: true,
      // Kinvo carries its own messages over its own socket, where they can be
      // moderated and stored. A data channel here would be an unmoderated side
      // channel between two people who may have just met.
      canPublishData: false,
      // No room administration: a participant must not be able to remove the
      // other person or mute their camera from the client.
      roomAdmin: false,
      roomCreate: false,
    });

    return {
      token: await token.toJwt(),
      room_name: room,
      identity: userId,
      server_url: env.LIVEKIT_URL!,
      expires_at: new Date(Date.now() + VIDEO_TOKEN_TTL_SECONDS * 1000),
    };
  },

  async readWebhook({ body, authorization }) {
    if (!authorization) {
      return null;
    }

    let event;

    try {
      event = await receiver().receive(body, authorization);
    } catch (error) {
      // A bad signature, a replayed request, or a body that is not an event.
      // All three are the same answer to the caller, and none is an error this
      // server can do anything about, so it is logged at warn rather than
      // thrown.
      logger.warn({ err: error }, 'video webhook failed verification');
      return null;
    }

    return {
      type: event.event === 'room_finished' ? 'room-ended' : 'other',
      roomName: event.room?.name ?? '',
    };
  },

  async closeRoom(room) {
    await rooms().deleteRoom(room);
  },
};

const stubVideoProvider: VideoProvider = {
  name: 'stub',
  isConfigured: false,

  roomNameFor: roomName,

  issueToken({ roomName: room, userId }) {
    logger.warn(
      { room_name: room },
      'LiveKit is not configured — issuing a non-functional development token',
    );

    return Promise.resolve({
      token: `dev-token-not-a-jwt.${room}.${userId}`,
      room_name: room,
      identity: userId,
      server_url: null,
      expires_at: new Date(Date.now() + VIDEO_TOKEN_TTL_SECONDS * 1000),
    });
  },

  readWebhook() {
    logger.warn('video webhook refused — LiveKit is not configured, so nothing can be verified');
    return Promise.resolve(null);
  },

  closeRoom() {
    // Nothing was ever opened.
    return Promise.resolve();
  },
};

let provider: VideoProvider | null = null;

export function getVideoProvider(): VideoProvider {
  if (provider) {
    return provider;
  }

  if (hasCredentials()) {
    provider = liveKitVideoProvider;
    return provider;
  }

  if (thirdPartyIntegrationsRequired) {
    // Unreachable while env validation requires these in production. Kept as a
    // hard stop: a production build handing out fake video tokens would look
    // like a broken client rather than a missing credential.
    throw new Error('LiveKit credentials are required in production');
  }

  // Tested against the WAIVER, not NODE_ENV. Staging is NODE_ENV=production
  // with the waiver on, and branching on NODE_ENV made starting a call answer
  // 500 there instead of returning a stub token the lifecycle can be exercised
  // with. The stub is deliberately not a JWT, so nothing can mistake it for a
  // working credential.
  provider = stubVideoProvider;
  return provider;
}

export function setVideoProvider(next: VideoProvider | null): void {
  provider = next;
  roomService = null;
  webhooks = null;
}
