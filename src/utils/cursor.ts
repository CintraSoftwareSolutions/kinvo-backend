import { PAGINATION } from '@config/constants';
import { ApiError } from '@utils/api-error';

/**
 * Opaque cursors (spec §4.5).
 *
 * Cursor pagination, not offset: a new match arriving mid-scroll shifts every
 * offset page and the user sees duplicates. A cursor names a position in the
 * ordering, so inserts elsewhere cannot disturb it.
 *
 * The encoding is base64 of JSON and is deliberately NOT a contract. The client
 * echoes back whatever it was handed and never parses it, which is what lets
 * the ordering key change later without a client release. Anything that reads a
 * cursor's contents outside this module has turned it into an API surface.
 */

export interface CursorPayload {
  /** The ordering key of the last item on the previous page. */
  k: string | number;
  /** Tie-breaker id, so rows sharing an ordering key still paginate exactly once. */
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * A cursor the client mangled is a client bug, not a server error, so it is a
 * 400 with a field message rather than a 500.
 */
export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw ApiError.validation({ cursor: ['That cursor is not valid.'] });
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('k' in parsed) ||
    !('id' in parsed) ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw ApiError.validation({ cursor: ['That cursor is not valid.'] });
  }

  return parsed as CursorPayload;
}

/**
 * Slices one page from a list fetched with `limit + 1` rows.
 *
 * Fetching one extra row is how `has_more` is known without a second COUNT
 * query — a count over a large filtered set costs more than the page itself.
 */
export function paginate<TItem>(
  rows: TItem[],
  limit: number,
  toCursor: (item: TItem) => CursorPayload,
): { items: TItem[]; next_cursor: string | null; has_more: boolean; limit: number } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    // Null rather than absent, and null on the last page rather than a cursor
    // that would return an empty list (spec §4.6).
    next_cursor: hasMore && last ? encodeCursor(toCursor(last)) : null,
    has_more: hasMore,
    limit,
  };
}

export function clampLimit(requested?: number): number {
  if (requested === undefined) {
    return PAGINATION.DEFAULT_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(requested)), PAGINATION.MAX_LIMIT);
}
