import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

import { API_VERSION } from '@config/constants';
import { CLIENT_EVENT_SCHEMAS, EVENT_DESCRIPTIONS, SERVER_EVENT_SCHEMAS } from '@/realtime/events';

/**
 * The realtime contract, published (spec §7, Batch 9).
 *
 * "Socket events must have documented payload shapes — the Flutter team needs
 * them as much as the REST contract."
 *
 * Generated from the same Zod schemas the socket server validates against, so
 * the document cannot describe a payload the server would reject. OpenAPI has
 * no vocabulary for socket events, so this is its own small document rather
 * than a bent-out-of-shape REST spec.
 */

interface EventDoc {
  event: string;
  direction: 'client_to_server' | 'server_to_client';
  description: string;
  payload: Record<string, unknown>;
}

function schemaFor(schema: ZodTypeAny): Record<string, unknown> {
  // `as never` for the same reason openapi.ts does it: zod-to-json-schema's
  // return type is inferred from the schema, and these are deep enough that
  // TypeScript gives up with "type instantiation is excessively deep". The
  // output is JSON either way.
  return zodToJsonSchema(schema as never, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

function describe(
  schemas: Record<string, ZodTypeAny>,
  direction: EventDoc['direction'],
): EventDoc[] {
  return Object.entries(schemas).map(([event, schema]) => ({
    event,
    direction,
    description: EVENT_DESCRIPTIONS[event] ?? '',
    payload: schemaFor(schema),
  }));
}

export function buildRealtimeDocument(serverUrl: string): Record<string, unknown> {
  return {
    kinvo_realtime: '1.0',
    api_version: API_VERSION,
    transport: 'socket.io',
    url: serverUrl,
    path: '/socket.io',
    authentication: {
      description:
        'Pass the access token in the Socket.IO handshake auth object: io(url, { auth: { token } }). An Authorization: Bearer header works too, for tools that cannot set handshake auth.',
      example: { auth: { token: '<access_token>' } },
      errors: {
        AUTH_REQUIRED: 'No token was supplied.',
        AUTH_TOKEN_EXPIRED: 'Refresh the token and reconnect. Do not sign the user out.',
        AUTH_TOKEN_INVALID: 'Sign the user out.',
        ACCOUNT_SUSPENDED: 'The account is suspended.',
        ONBOARDING_INCOMPLETE:
          'Finish onboarding first. An un-onboarded account has no matches, so there is nothing to receive.',
      },
      note: 'The error code arrives on the connect_error event as error.data.code.',
    },
    guarantees: {
      durability:
        'Persist first, then emit. Every server event describes something already committed. A dropped socket costs a refresh, never a message — refetch over REST after a reconnect and nothing is lost.',
      delivery:
        'At-most-once, best effort. There is no acknowledgement or replay. Do not treat an emit as a write.',
      ordering:
        'Per socket, events arrive in the order the server sent them. Across reconnects, order is not guaranteed — sort by created_at.',
      rooms:
        'You are joined to your own user room automatically, so events reach every device you have open. Typing indicators require sending typing:start, which joins the conversation room for the thread you have on screen.',
    },
    events: [
      ...describe(CLIENT_EVENT_SCHEMAS, 'client_to_server'),
      ...describe(SERVER_EVENT_SCHEMAS, 'server_to_client'),
    ],
  };
}
