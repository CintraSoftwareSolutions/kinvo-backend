import { API_PREFIX } from '@config/constants';
import type { Mode } from '@/db/prisma';
import { CAMDEN, LONDON } from './factories';
import { createDiscoverableViewer } from './discovery';
import { authHeader } from './auth';
import { api } from './request';

/**
 * A matched pair, created the ONLY way the product creates one: two people
 * liking each other through the API.
 *
 * Inserting match rows directly would test a shape the product cannot produce
 * — in particular it would skip conversation creation, which happens inside the
 * match transaction, and every chat test would then be exercising a fixture
 * rather than the code.
 */

export type Viewer = Awaited<ReturnType<typeof createDiscoverableViewer>>;

export async function matchPair(
  mode: Mode,
  alsoModes: Mode[] = [],
  existing?: { a: Viewer; b: Viewer },
): Promise<{ a: Viewer; b: Viewer; conversation_id: string; match_id: string }> {
  const a =
    existing?.a ??
    (await createDiscoverableViewer({
      mode,
      coordinates: LONDON,
      also_modes: alsoModes,
      display_name: 'Alex',
    }));
  const b =
    existing?.b ??
    (await createDiscoverableViewer({
      mode,
      coordinates: CAMDEN,
      also_modes: alsoModes,
      display_name: 'Blake',
    }));

  await api
    .post(`${API_PREFIX}/discovery/${mode}/swipe`)
    .set(authHeader(b.tokens))
    .send({ target_id: a.user_id, action: 'like' });

  const result = await api
    .post(`${API_PREFIX}/discovery/${mode}/swipe`)
    .set(authHeader(a.tokens))
    .send({ target_id: b.user_id, action: 'like' });

  const matchId = result.body?.data?.match?.id as string | undefined;

  if (!matchId) {
    throw new Error(`matchPair did not produce a match: ${JSON.stringify(result.body)}`);
  }

  const list = await api.get(`${API_PREFIX}/matches?mode=${mode}`).set(authHeader(a.tokens));
  const row = (list.body.data as { id: string; conversation_id: string }[]).find(
    (entry) => entry.id === matchId,
  );

  return { a, b, match_id: matchId, conversation_id: row?.conversation_id ?? '' };
}

/** Sends a text message and returns the created message body. */
export async function sendText(from: Viewer, conversationId: string, body: string) {
  const response = await api
    .post(`${API_PREFIX}/conversations/${conversationId}/messages`)
    .set(authHeader(from.tokens))
    .send({ type: 'text', body });

  return response;
}
