import { PAGINATION } from '@config/constants';
import { ApiError } from '@utils/api-error';

export interface CursorPayload {
  k: string | number;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

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
