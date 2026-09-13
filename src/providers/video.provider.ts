import twilio from 'twilio';

import { env, thirdPartyIntegrationsRequired } from '@config/env';
import { logger } from '@utils/logger';

/**
 * Video calling (spec §7, Batch 14).
 *
 * Behind an interface because Twilio announced an end-of-life for Programmable
 * Video and then reversed it (spec §1). The product is supported again, but a
 * vendor that has once tried to shut a product down may try again, and swapping
 * to LiveKit or Agora must be a new class here rather than a change to the call
 * lifecycle.
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
 * Twilio disconnects a participant when their token expires, so this is a floor
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
  expires_at: Date;
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
   */
  issueToken(options: { roomName: string; userId: string }): VideoToken;
}

function hasCredentials(): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET);
}

function roomName(callId: string): string {
  return `kinvo-call-${callId}`;
}

const twilioVideoProvider: VideoProvider = {
  name: 'twilio',
  isConfigured: true,

  roomNameFor: roomName,

  issueToken({ roomName: room, userId }) {
    const { AccessToken } = twilio.jwt;

    const token = new AccessToken(
      env.TWILIO_ACCOUNT_SID!,
      env.TWILIO_API_KEY_SID!,
      env.TWILIO_API_KEY_SECRET!,
      // The identity is our user id, not a name or an email. It is visible to
      // the other participant in the room, so it must not carry PII.
      { identity: userId, ttl: VIDEO_TOKEN_TTL_SECONDS },
    );

    // Scoped to ONE room. `room` is required here rather than optional by
    // choice: a VideoGrant with no room grants every room on the account.
    token.addGrant(new AccessToken.VideoGrant({ room }));

    return {
      token: token.toJwt(),
      room_name: room,
      identity: userId,
      expires_at: new Date(Date.now() + VIDEO_TOKEN_TTL_SECONDS * 1000),
    };
  },
};

/**
 * Development stand-in for machines without Twilio Video credentials.
 *
 * Returns a token that is deliberately NOT a JWT and could never authenticate
 * against Twilio. A plausible-looking fake would be worse: it would let a test
 * or a staging client believe it had connected when it had not.
 *
 * Selected when Twilio is unconfigured AND the integration waiver is on. A real
 * production deployment leaves the waiver at its default, so env validation
 * makes the credentials mandatory and this object cannot be reached there.
 *
 * It IS reachable on staging, deliberately — the call lifecycle is worth
 * exercising end to end without a Twilio account.
 */
const stubVideoProvider: VideoProvider = {
  name: 'stub',
  isConfigured: false,

  roomNameFor: roomName,

  issueToken({ roomName: room, userId }) {
    logger.warn(
      { room_name: room },
      'Twilio Video is not configured — issuing a non-functional development token',
    );

    return {
      token: `dev-token-not-a-jwt.${room}.${userId}`,
      room_name: room,
      identity: userId,
      expires_at: new Date(Date.now() + VIDEO_TOKEN_TTL_SECONDS * 1000),
    };
  },
};

let provider: VideoProvider | null = null;

export function getVideoProvider(): VideoProvider {
  if (provider) {
    return provider;
  }

  if (hasCredentials()) {
    provider = twilioVideoProvider;
    return provider;
  }

  if (thirdPartyIntegrationsRequired) {
    // Unreachable while env validation requires these in production. Kept as a
    // hard stop: a production build handing out fake video tokens would look
    // like a broken client rather than a missing credential.
    throw new Error('Twilio Video credentials are required in production');
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
}
