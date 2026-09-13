import { API_PREFIX } from '@config/constants';
import {
  CLIENT_EVENTS,
  CLIENT_EVENT_SCHEMAS,
  EVENT_DESCRIPTIONS,
  SERVER_EVENTS,
  SERVER_EVENT_SCHEMAS,
} from '@/realtime/events';
import { api } from '../../helpers/request';

/**
 * The published realtime contract (spec §7, Batch 9).
 *
 * "Socket events must have documented payload shapes — the Flutter team needs
 * them as much as the REST contract." These tests are the drift guard: an event
 * added to the server without a documented shape fails the build, exactly as an
 * undocumented REST endpoint does.
 */

const REALTIME = `${API_PREFIX}/docs/realtime.json`;

interface EventDoc {
  event: string;
  direction: string;
  description: string;
  payload: Record<string, unknown>;
}

describe('GET /docs/realtime.json', () => {
  it('serves the contract without the REST envelope', async () => {
    const response = await api.get(REALTIME);

    expect(response.status).toBe(200);
    // A machine-readable contract document, like openapi.json — tools expect
    // it at the top level, not wrapped.
    expect(response.body.kinvo_realtime).toBe('1.0');
    expect(response.body.transport).toBe('socket.io');
    expect(response.body.path).toBe('/socket.io');
  });

  it('documents every event the server handles or emits', async () => {
    const response = await api.get(REALTIME);
    const documented = new Set((response.body.events as EventDoc[]).map((e) => e.event));

    for (const event of Object.values(CLIENT_EVENTS)) {
      expect(documented.has(event)).toBe(true);
    }

    for (const event of Object.values(SERVER_EVENTS)) {
      expect(documented.has(event)).toBe(true);
    }
  });

  it('documents nothing the server does not actually speak', async () => {
    const response = await api.get(REALTIME);
    const known = new Set<string>([
      ...Object.values(CLIENT_EVENTS),
      ...Object.values(SERVER_EVENTS),
    ]);

    for (const doc of response.body.events as EventDoc[]) {
      expect(known.has(doc.event)).toBe(true);
    }
  });

  it('gives every event a payload schema and a direction', async () => {
    const response = await api.get(REALTIME);

    for (const doc of response.body.events as EventDoc[]) {
      expect(['client_to_server', 'server_to_client']).toContain(doc.direction);
      expect(doc.payload).toBeDefined();
      expect(typeof doc.payload).toBe('object');
    }
  });

  it('explains every event in prose, not just a shape', () => {
    // A schema says what the fields are; it never says when the event fires or
    // what to do about it. Both halves are the contract.
    for (const event of [...Object.values(CLIENT_EVENTS), ...Object.values(SERVER_EVENTS)]) {
      expect(EVENT_DESCRIPTIONS[event] ?? '').not.toBe('');
    }
  });

  it('keeps a schema for every declared event name', () => {
    for (const event of Object.values(CLIENT_EVENTS)) {
      expect(CLIENT_EVENT_SCHEMAS[event]).toBeDefined();
    }
    for (const event of Object.values(SERVER_EVENTS)) {
      expect(SERVER_EVENT_SCHEMAS[event]).toBeDefined();
    }
  });

  it('states the durability guarantee, because it changes how the client is built', async () => {
    const response = await api.get(REALTIME);

    // A team that assumes the socket is durable will lose messages. Saying so
    // in the contract is cheaper than the bug report.
    expect(response.body.guarantees.durability).toMatch(/persist first/i);
    expect(response.body.guarantees.delivery).toMatch(/at-most-once/i);
  });

  it('documents the handshake and its error codes', async () => {
    const response = await api.get(REALTIME);

    expect(response.body.authentication.errors.AUTH_TOKEN_EXPIRED).toMatch(/reconnect/i);
    expect(response.body.authentication.errors.AUTH_TOKEN_INVALID).toMatch(/sign the user out/i);
  });
});
