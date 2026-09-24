/**
 * The shape every read endpoint speaks.
 *
 * This is the part of Vestiarion that is hard to change later. An MCP server,
 * a Slack bot and anybody's SDK will all branch on these fields, so the
 * decisions here outlive the code that serves them:
 *
 * **Versioned path.** Routes live under `/api/v1`. Without a version the first
 * breaking change breaks every consumer silently; with one, a second shape can
 * exist beside the first while callers move.
 *
 * **One envelope.** Every success is `{ data }`, optionally with `page`.
 * Returning a bare array from some endpoints and an object from others is the
 * kind of inconsistency a client library ends up encoding as a special case
 * per route.
 *
 * **Coded errors.** `{ error: { code, message } }` with `code` from a closed
 * set. A bot deciding whether to retry needs to distinguish "rate limited"
 * from "not found" without parsing English.
 *
 * **Opaque cursors.** A caller must not construct one. That is what lets the
 * ordering change later — from a timestamp to a sequence, say — without
 * breaking anyone who stored a cursor.
 */

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "unavailable"
  | "internal";

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

export interface ApiPage {
  /** Pass back as `?cursor=` to continue. Null when the end is reached. */
  nextCursor: string | null;
  hasMore: boolean;
  /** How many items this response carries. */
  count: number;
}

export interface ApiCollection<T> {
  data: T[];
  page: ApiPage;
}

export interface ApiResource<T> {
  data: T;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const STATUS_FOR: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/**
 * A page cursor. Opaque to callers, and deliberately not signed: it carries no
 * authority, only a position, and every request is authenticated anyway.
 * Encoded rather than raw so that a caller cannot come to depend on its
 * contents and so a malformed one is recognisable rather than being read as a
 * plausible position.
 */
export interface CursorPayload {
  /** The value ordering was done by: a ledger sequence, or an ISO timestamp. */
  k: string | number;
  /** Tiebreak for rows sharing a key. */
  id?: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): CursorPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { k, id } = parsed as CursorPayload;
    if (typeof k !== "string" && typeof k !== "number") return null;
    if (id !== undefined && typeof id !== "string") return null;
    return { k, ...(id === undefined ? {} : { id }) };
  } catch {
    return null;
  }
}

/**
 * Clamps a caller-supplied page size. An unbounded limit is a way to ask one
 * request to read an entire ledger, so the ceiling is enforced rather than
 * documented.
 */
export function parseLimit(raw: string | null): { limit: number } | { error: string } {
  if (raw == null || raw === "") return { limit: DEFAULT_PAGE_SIZE };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return { error: `limit must be a positive integer, got "${raw}"` };
  }
  return { limit: Math.min(value, MAX_PAGE_SIZE) };
}

/**
 * Builds a page from one extra row.
 *
 * Asking for `limit + 1` and dropping the last is how `hasMore` becomes a fact
 * rather than a guess — a count query would be a second round trip and could
 * disagree with the rows already read.
 */
export function paginate<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => CursorPayload
): ApiCollection<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    page: {
      nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
      hasMore,
      count: data.length,
    },
  };
}
