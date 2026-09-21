import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';

import { env, thirdPartyIntegrationsRequired } from '@config/env';
import { logger } from '@utils/logger';

/**
 * Video calling (spec §7, Batch 14; provider changed in Batch 16).
 *
 * The provider is LiveKit. It was Twilio, and the reason for the change is the
 * CLIENT rather than the service: Twilio Programmable Video is supported again
 * after its cancelled end-of-life, but Twilio publishes no Flutter SDK, and the
 * only community plugin was last released in 2023 and says on its own page that
 * it should not be used in production apps. LiveKit publishes and maintains one.
 *
 * This file is the whole of the change, which is what the interface was for.
 * Nothing in the call lifecycle knows which vendor is behind it.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, quoted from the spec:
 *
 *   "Tokens must be short-lived and scoped to a specific room. Never issue a
 *    token that grants access to arbitrary rooms."
 *
 * So `issueToken` takes a room name and grants that room ONLY. There is no
 * variant that omits the room, and no caller can widen the grant — a token that
 * worked for any room would let one match's participant walk into another's
 * call, which is a stranger appearing on someone's camera.
 */

/**
 * One hour.
 *
 * LiveKit refuses a connection once the token has expired, so this is a floor
 * set by how long a call can plausibly run, not a number picked for tidiness.
 * Ten minutes would be safer and would also cut people off mid-conversation.
 *
 * An hour is short enough that a leaked token is worth little, and
 * `GET /calls/:id/token` re-issues for a longer call or a reconnect — which is
 * the part that makes a short TTL workable rather than merely strict.
 */
export const VIDEO_TOKEN_TTL_SECONDS = 60 * 60;

export interface VideoToken {
  token: string;
  /** The single room this token admits its holder to, and no other. */
  room_name: string;
  /** Who the token says the holder is. Always our user id. */
  identity: string;
  /**
   * The server the app connects to, as the provider gives it (`wss://…`).
   *
   * Returned with the token rather than published in `/config`, because a
   * token is worthless without the host it was minted for, and a client that
   * has one and not the other has nothing it can act on. Null when no provider
   * is configured, which is how the app knows there is no media to join.
   */
  server_url: string | null;
  expires_at: Date;
}

/**
 * A callback from the provider, already verified and reduced to what the call
 * lifecycle acts on.
 *
 * Each vendor names its events differently and signs them differently, so the
 * provider — not the controller — is what reads them. `room-ended` is the only
 * type that changes anything; everything else is reported so it can be logged
 * and ignored.
 */
export interface VideoRoomEvent {
  type: 'room-ended' | 'other';
  roomName: string;
}

export interface VideoProvider {
  readonly name: string;
  readonly isConfigured: boolean;

  /**
   * The room name for a call.
   *
   * Derived from the call id, which is a server-generated UUID, so a room name
   * cannot be guessed and cannot be supplied by a client. A client-named room
   * would let someone name a room they were not invited to.
   */
  roomNameFor(callId: string): string;

  /**
   * Takes the room name RATHER THAN the call id, deliberately.
   *
   * The caller reads the room from the stored call row, so the room a client is
   * told to join and the room its token admits it to are the same string by
   * construction. Re-deriving it here from an id would be a second source of
   * truth, and the failure mode is a token that silently grants a different
   * room than the one the app connects to.
   *
   * Async because LiveKit signs the JWT with WebCrypto.
   */
  issueToken(options: { roomName: string; userId: string }): Promise<VideoToken>;

  /**
   * Verifies a callback really came from the provider, and reads it.
   *
   * Returns null when the request cannot be proved to be the provider's, which
   * the controller turns into 403. Verification and parsing are one step on
   * purpose: LiveKit's signature covers a sha256 of the RAW body, so the bytes
   * that are checked must be the bytes that are read. Splitting them would
   * allow a body to be verified and then a different parse acted upon.
   */
  readWebhook(options: { body: string; authorization?: string }): Promise<VideoRoomEvent | null>;

  /**
   * Closes a room, so a client that ignores `call:ended` still loses the media.
   *
   * Best-effort by contract: the caller has already ended the call in the
   * database and told both sides. This is the belt to that braces, and it is
   * what makes "end and report" mean the camera actually goes off rather than
   * relying on the reported person's app to behave.
   */
  closeRoom(roomName: string): Promise<void>;
}

function hasCredentials(): boolean {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

function roomName(callId: string): string {
  return `kinvo-call-${callId}`;
}

/**
 * The management API is HTTPS; the media URL clients connect to is WSS. They
 * are the same host, so the scheme is swapped rather than configured twice —
 * two variables that must agree is two variables that can disagree.
 */
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

/**
 * Development stand-in for machines with no LiveKit project.
 *
 * Returns a token that is deliberately NOT a JWT and could never authenticate
 * against LiveKit, and no server URL. A plausible-looking fake would be worse:
 * it would let a test or a staging client believe it had connected when it had
 * not.
 *
 * Selected when LiveKit is unconfigured AND the integration waiver is on. A
 * real production deployment leaves the waiver at its default, so env
 * validation makes the credentials mandatory and this object cannot be reached
 * there.
 *
 * It IS reachable on staging, deliberately — the call lifecycle is worth
 * exercising end to end without a LiveKit project, and the app is built to show
 * "video is not available here" rather than to fail.
 */
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

  /**
   * Refuses every callback, and that is the correct answer.
   *
   * Without credentials there is no shared secret to verify against, so nothing
   * can be proved about who sent the request — and this endpoint ENDS CALLS.
   * Accepting unverified callbacks would let anyone hang up anyone by guessing
   * a room name.
   *
   * Nothing is lost by refusing: with no LiveKit project there are no LiveKit
   * callbacks, and `sweepStuckCalls` closes abandoned calls either way.
   */
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

/** Tests swap in a stub; without a reset it leaks into the next suite. */
export function setVideoProvider(next: VideoProvider | null): void {
  provider = next;
  roomService = null;
  webhooks = null;
}
