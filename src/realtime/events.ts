import { z } from 'zod';

import { MessageType, Mode, NotificationCategory } from '@/db/prisma';

/**
 * The realtime contract (spec §7, Batch 9).
 *
 * "Socket events must have documented payload shapes — the Flutter team needs
 * them as much as the REST contract." So the shapes are Zod schemas, not
 * hand-written prose: they validate incoming payloads at runtime AND generate
 * the published documentation, which means the docs cannot describe a shape the
 * server does not accept.
 *
 * DURABILITY RULE (spec §7): persist first, then emit. Every server-to-client
 * event below describes something already committed to Postgres. A socket
 * delivery that is lost costs a client a refresh, never a message. Nothing in
 * this system treats an emit as a write.
 */

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const CLIENT_EVENTS = {
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  CONVERSATION_READ: 'conversation:read',
  PRESENCE_PING: 'presence:ping',
} as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];

const conversationRef = z.object({ conversation_id: z.string().uuid() }).strict();

export const CLIENT_EVENT_SCHEMAS = {
  [CLIENT_EVENTS.TYPING_START]: conversationRef,
  [CLIENT_EVENTS.TYPING_STOP]: conversationRef,
  [CLIENT_EVENTS.CONVERSATION_READ]: conversationRef,
  /** Keeps `last_active_at` fresh while the app is open but idle. */
  [CLIENT_EVENTS.PRESENCE_PING]: z.object({}).strict(),
} as const satisfies Record<ClientEvent, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const SERVER_EVENTS = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_READ: 'message:read',
  TYPING: 'typing',
  MATCH_NEW: 'match:new',
  CONVERSATION_UPDATED: 'conversation:updated',
  PRESENCE_UPDATE: 'presence:update',
  ENTITLEMENTS_UPDATED: 'entitlements:updated',
  NOTIFICATION_NEW: 'notification:new',
  CALL_INCOMING: 'call:incoming',
  CALL_ANSWERED: 'call:answered',
  CALL_DECLINED: 'call:declined',
  CALL_ENDED: 'call:ended',
  ERROR: 'error',
} as const;

export type ServerEvent = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

const userCompactShape = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  age: z.number().int().nullable(),
  primary_photo_url: z.string().nullable(),
  is_verified: z.boolean(),
  is_premium: z.boolean(),
  is_online: z.boolean(),
  last_active_at: z.string(),
});

export const SERVER_EVENT_SCHEMAS = {
  /** A message was persisted. The REST payload shape, unchanged. */
  [SERVER_EVENTS.MESSAGE_NEW]: z.object({
    id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    sender_id: z.string().uuid(),
    type: z.nativeEnum(MessageType),
    body: z.string().nullable(),
    media_url: z.string().nullable(),
    venue_id: z.string().uuid().nullable(),
    duration_ms: z.number().int().nullable(),
    moderation_flagged: z.boolean(),
    moderation_overridden: z.boolean(),
    read_at: z.string().nullable(),
    created_at: z.string(),
  }),

  /** The other participant read up to `read_at`. Update the ticks. */
  [SERVER_EVENTS.MESSAGE_READ]: z.object({
    conversation_id: z.string().uuid(),
    reader_id: z.string().uuid(),
    read_at: z.string(),
  }),

  /**
   * Ephemeral and never persisted — the one thing in this system that is
   * genuinely fire-and-forget. A lost typing indicator costs nothing.
   */
  [SERVER_EVENTS.TYPING]: z.object({
    conversation_id: z.string().uuid(),
    user_id: z.string().uuid(),
    is_typing: z.boolean(),
  }),

  [SERVER_EVENTS.MATCH_NEW]: z.object({
    match_id: z.string().uuid(),
    conversation_id: z.string().uuid().nullable(),
    mode: z.nativeEnum(Mode),
    is_super_like: z.boolean(),
    matched_at: z.string(),
    expires_at: z.string(),
    user: userCompactShape,
  }),

  /** Unread moved. Cheaper than refetching the list to update one badge. */
  [SERVER_EVENTS.CONVERSATION_UPDATED]: z.object({
    conversation_id: z.string().uuid(),
    unread_count: z.number().int(),
    last_message_at: z.string().nullable(),
    last_message_preview: z.string().nullable(),
  }),

  /**
   * Only ever delivered to people with an active match with this user, and
   * never to anyone on either side of a block.
   */
  [SERVER_EVENTS.PRESENCE_UPDATE]: z.object({
    user_id: z.string().uuid(),
    is_online: z.boolean(),
    last_active_at: z.string(),
  }),

  /**
   * The user's plan changed — a purchase cleared, a subscription lapsed. Re-read
   * `GET /me/entitlements`; this event carries the tier but never the flags, so
   * there is one authority on what a plan includes.
   */
  [SERVER_EVENTS.ENTITLEMENTS_UPDATED]: z.object({
    tier: z.string(),
  }),

  /** A notification was added to the feed. The same shape GET /notifications lists. */
  [SERVER_EVENTS.NOTIFICATION_NEW]: z.object({
    id: z.string().uuid(),
    category: z.nativeEnum(NotificationCategory),
    title: z.string(),
    body: z.string(),
    data: z.record(z.unknown()),
    read_at: z.string().nullable(),
    created_at: z.string(),
  }),

  /**
   * Someone you matched with is calling. This is what makes the callee's phone
   * ring, so it is the one event a client must handle before it has fetched
   * anything.
   *
   * The push notification carries the same call_id. A client that receives both
   * must treat them as one call, not two.
   */
  [SERVER_EVENTS.CALL_INCOMING]: z.object({
    call_id: z.string().uuid(),
    match_id: z.string().uuid(),
    mode: z.nativeEnum(Mode),
    from: userCompactShape,
  }),

  /** The callee picked up. Stop the ringing UI and connect to the room. */
  [SERVER_EVENTS.CALL_ANSWERED]: z.object({
    call_id: z.string().uuid(),
  }),

  /** The callee refused. Distinct from ended so the caller can say so. */
  [SERVER_EVENTS.CALL_DECLINED]: z.object({
    call_id: z.string().uuid(),
  }),

  /**
   * The other side hung up, or a safety action ended the call.
   *
   * duration_seconds is null when the call was never answered — a missed call
   * has no duration, and zero would read as a call that connected silently.
   */
  [SERVER_EVENTS.CALL_ENDED]: z.object({
    call_id: z.string().uuid(),
    duration_seconds: z.number().int().nullable(),
  }),

  /** Same code vocabulary as REST, so the client branches on one enum. */
  [SERVER_EVENTS.ERROR]: z.object({
    code: z.string(),
    message: z.string(),
  }),
} as const satisfies Record<ServerEvent, z.ZodTypeAny>;

export type MessageNewPayload = z.infer<
  (typeof SERVER_EVENT_SCHEMAS)[typeof SERVER_EVENTS.MESSAGE_NEW]
>;
export type MatchNewPayload = z.infer<
  (typeof SERVER_EVENT_SCHEMAS)[typeof SERVER_EVENTS.MATCH_NEW]
>;
export type ConversationUpdatedPayload = z.infer<
  (typeof SERVER_EVENT_SCHEMAS)[typeof SERVER_EVENTS.CONVERSATION_UPDATED]
>;
export type PresenceUpdatePayload = z.infer<
  (typeof SERVER_EVENT_SCHEMAS)[typeof SERVER_EVENTS.PRESENCE_UPDATE]
>;
export type CallIncomingPayload = z.infer<
  (typeof SERVER_EVENT_SCHEMAS)[typeof SERVER_EVENTS.CALL_INCOMING]
>;

/** Prose for the published documentation, kept beside the shapes it describes. */
export const EVENT_DESCRIPTIONS: Record<string, string> = {
  [CLIENT_EVENTS.TYPING_START]: 'Tell the other participant you are typing. Not persisted.',
  [CLIENT_EVENTS.TYPING_STOP]:
    'Stop the indicator. Also sent automatically by the server when you send a message, so the client does not have to.',
  [CLIENT_EVENTS.CONVERSATION_READ]:
    'Mark a conversation read. Does exactly what POST /conversations/{id}/read does, through the socket you already have open.',
  [CLIENT_EVENTS.PRESENCE_PING]:
    'Keeps last_active_at fresh while the app is open but idle. Once a minute is plenty.',
  [SERVER_EVENTS.MESSAGE_NEW]:
    'A message was persisted in one of your conversations. Identical shape to the REST message object.',
  [SERVER_EVENTS.MESSAGE_READ]: 'The other participant read the thread. Update your ticks.',
  [SERVER_EVENTS.TYPING]: 'Someone in a conversation started or stopped typing. Ephemeral.',
  [SERVER_EVENTS.MATCH_NEW]: 'A mutual like just created a match, in one specific mode.',
  [SERVER_EVENTS.CONVERSATION_UPDATED]:
    'Unread count or last message changed. Update the row without refetching the list.',
  [SERVER_EVENTS.PRESENCE_UPDATE]:
    'Someone you have an active match with came online or went offline. Never sent across a block.',
  [SERVER_EVENTS.ENTITLEMENTS_UPDATED]:
    'The plan changed. Re-read GET /me/entitlements rather than trusting a cached matrix.',
  [SERVER_EVENTS.NOTIFICATION_NEW]:
    'A notification was added to the feed. Update the badge and the list without refetching. Not sent for categories the user switched off in-app.',
  [SERVER_EVENTS.CALL_INCOMING]:
    'Someone you matched with is calling. Handle this before anything else — it is what rings the phone. The matching push notification carries the same call_id; treat both as one call. Answer with POST /calls/{id}/answer to get a room token.',
  [SERVER_EVENTS.CALL_ANSWERED]:
    'The callee picked up. Stop the ringing UI and join the room with the token you already hold.',
  [SERVER_EVENTS.CALL_DECLINED]: 'The callee refused. Separate from call:ended on purpose.',
  [SERVER_EVENTS.CALL_ENDED]:
    'The call is over — the other side hung up, or a safety action ended it. duration_seconds is null for a call that was never answered.',
  [SERVER_EVENTS.ERROR]:
    'Something went wrong with an event you sent. Uses the same error codes as the REST API.',
};
