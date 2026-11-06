import { db, unwrap } from "@/lib/dal";
import { guardApiRequest, apiError, handleApiRequest } from "@/lib/api/guard";
import {
  decodeCursor,
  isSequenceCursor,
  paginate,
  parseLimit,
  type ApiCollection,
} from "@/lib/api/contract";

export const dynamic = "force-dynamic";

/**
 * The audit chain, oldest first, as a resumable stream.
 *
 * This is the endpoint an integration actually lives on. A Slack or Telegram
 * bot does not want "the last 50 entries" — it wants *everything since it last
 * looked*, exactly once, with nothing missed and nothing repeated. The ledger
 * is the one table where that is trivially correct: `seq` is a gap-free
 * identity column on an append-only table, so a cursor on it can neither skip
 * an entry written concurrently nor return one twice.
 *
 * Ascending order is deliberate and is the opposite of what the dashboard
 * wants. A newest-first feed cannot be resumed: new rows arrive at the front,
 * so a stored position drifts. Ascending means a cursor is a watermark.
 *
 * `order=desc` is the exception for a caller that keeps no position, such as a
 * Zapier polling trigger (docs/superpowers/specs/2026-11-06-zapier-integration-design.md
 * Z1): the newest `limit` entries, newest first, and no cursor either way.
 */
export interface LedgerEntryPayload {
  seq: number;
  id: string;
  ts: string;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  /** Present so a consumer can verify the chain itself rather than trust us. */
  bodyHash: string;
  signature: string;
  prevHash: string;
  hash: string;
  /**
   * Which key signed the entry; `null` for entries written before key identity
   * existed. A consumer verifying for itself needs this to pick the right key,
   * or it hits the ambiguity this field was added to remove: an intact chain
   * and the wrong key look identical without it.
   */
  signingKeyId: string | null;
}

export async function GET(request: Request) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const url = new URL(request.url);
  const limitResult = parseLimit(url.searchParams.get("limit"));
  if ("error" in limitResult) return apiError("invalid_request", limitResult.error);

  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    // A cursor that cannot be read is a caller bug, and continuing from the
    // beginning would silently replay the whole ledger to a bot that thought
    // it was resuming.
    return apiError("invalid_request", "cursor is not a cursor this API issued.");
  }
  // Another endpoint's cursor decodes too; its `k` would reach the query as NaN.
  if (cursor && !isSequenceCursor(cursor)) {
    return apiError("invalid_request", "cursor is not valid for this endpoint.");
  }

  const order = url.searchParams.get("order") ?? "asc";
  if (order !== "asc" && order !== "desc") return apiError("invalid_request", "order must be asc or desc.");
  // A watermark read the other way round would skip or repeat entries: newest first is one page, with no cursor.
  if (order === "desc" && rawCursor) return apiError("invalid_request", "cursor reads oldest first; order=desc takes none.");

  const domain = url.searchParams.get("domain");
  const actor = url.searchParams.get("actor");

  return handleApiRequest(
    "GET /api/v1/ledger",
    guard.key,
    async (): Promise<ApiCollection<LedgerEntryPayload>> => {
      let query = db()
        .from("ledger_entries")
        .select("seq, id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash, signing_key_id")
        .order("seq", { ascending: order === "asc" })
        // One more than asked for, so `hasMore` is observed rather than guessed.
        .limit(limitResult.limit + 1);

      if (cursor) query = query.gt("seq", cursor.k);
      if (domain) query = query.eq("domain", domain);
      if (actor) query = query.eq("actor", actor);

      const rows = unwrap(await query) as Array<Record<string, unknown>>;

      const entries: LedgerEntryPayload[] = rows.map((row) => ({
        seq: Number(row.seq),
        id: String(row.id),
        ts: String(row.ts),
        actor: String(row.actor),
        domain: String(row.domain),
        action: String(row.action),
        summary: String(row.summary),
        detail: (row.detail ?? {}) as Record<string, unknown>,
        bodyHash: String(row.body_hash),
        signature: String(row.signature),
        prevHash: String(row.prev_hash),
        hash: String(row.hash),
        signingKeyId: row.signing_key_id == null ? null : String(row.signing_key_id),
      }));

      const collection = paginate(entries, limitResult.limit, (entry) => ({ k: entry.seq }));
      // Newest first says whether older entries exist, and gives no cursor to page back with.
      return order === "desc" ? { ...collection, page: { ...collection.page, nextCursor: null } } : collection;
    }
  );
}
