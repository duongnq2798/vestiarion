import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { platformDb, unwrap } from "../dal";
import type { AuthenticatedKey } from "../platform/api-keys";
import { apiError, INTERNAL_MESSAGE } from "./guard";

/**
 * `Idempotency-Key` for the write API (docs/superpowers/specs/2026-10-03-write-api-design.md R5): a client that does
 * not know whether its write landed (a timeout, a dropped connection) sends it again with the same key, and the write
 * is done once. The key is claimed in `api_idempotency` before the write runs; the outcome is kept for a day and given
 * back to a repeat with the same body; a repeat with another body, or while the first is still running, is a
 * conflict. A 5xx is not kept, so a retry after a server failure runs the write again, and neither is a claim whose
 * request died before it stored an outcome: after `IN_FLIGHT_TIMEOUT_MS` the next request with the key takes it over.
 * When the table cannot be reached, the answer is the API's own 500, and nothing runs.
 */

/** How long an outcome is given back for a repeated key. */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/**
 * How long a claim may stay without an outcome before it is taken to belong to a request that died, timed out or lost
 * the table mid-write. Longer than any function here may run (300 seconds at most), so a request still running is
 * never overtaken.
 */
export const IN_FLIGHT_TIMEOUT_MS = 10 * 60_000;
/** 1–255 visible ASCII characters: no spaces, nothing a header would fold or trim. */
const KEY_FORMAT = /^[\x21-\x7e]{1,255}$/;

interface StoredOutcome {
  request_hash: string;
  status: number | null;
  response: unknown;
  created_at: string;
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export async function withIdempotency(
  request: Request,
  key: AuthenticatedKey,
  rawBody: string,
  run: () => Promise<NextResponse>,
  options: { now?: () => number } = {}
): Promise<NextResponse> {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null) return run();
  if (!KEY_FORMAT.test(idempotencyKey)) {
    return apiError("invalid_request", "Idempotency-Key must be 1 to 255 visible ASCII characters, with no spaces.");
  }

  const now = options.now ?? Date.now;
  const requestHash = sha256(`${request.method} ${new URL(request.url).pathname}\n${rawBody}`);
  const table = () => platformDb().from("api_idempotency");
  const release = async () => {
    const result = await table().delete().eq("org_id", key.orgId).eq("idempotency_key", idempotencyKey);
    if (result.error) console.error("[api] idempotency claim not released", result.error.message);
  };

  try {
    return await claimAndRun();
  } catch (error) {
    // The claim could not be made or read, so nothing ran: answered as the API answers any failure, and safe to retry.
    console.error("[api] idempotency store failed", error instanceof Error ? error.message : error);
    return apiError("internal", INTERNAL_MESSAGE);
  }

  async function claimAndRun(): Promise<NextResponse> {
    // Twice at most: a second pass follows an outcome that was released or had expired, or a claim taken over.
    for (let pass = 0; pass < 2; pass += 1) {
      const claimed = unwrap(
        await table()
          .upsert(
            { org_id: key.orgId, idempotency_key: idempotencyKey, request_hash: requestHash },
            { onConflict: "org_id,idempotency_key", ignoreDuplicates: true }
          )
          .select("org_id")
      ) as Array<{ org_id: string }>;

      if (claimed.length > 0) {
        let response: NextResponse;
        try {
          response = await run();
        } catch (error) {
          await release();
          throw error;
        }
        if (response.status >= 500) {
          await release();
          return response;
        }
        const body = await response
          .clone()
          .json()
          .catch(() => null);
        const stored = await table()
          .update({ status: response.status, response: body, completed_at: new Date(now()).toISOString() })
          .eq("org_id", key.orgId)
          .eq("idempotency_key", idempotencyKey);
        if (stored.error) console.error("[api] idempotency outcome not stored", stored.error.message);
        return response;
      }

      const rows = unwrap(
        await table().select("request_hash, status, response, created_at").eq("org_id", key.orgId).eq("idempotency_key", idempotencyKey).limit(1)
      ) as StoredOutcome[];
      const existing = rows[0];
      if (!existing) continue;
      if (Date.parse(existing.created_at) < now() - IDEMPOTENCY_TTL_MS) {
        await table().delete().eq("org_id", key.orgId).eq("idempotency_key", idempotencyKey).eq("created_at", existing.created_at);
        continue;
      }
      if (existing.status === null && Date.parse(existing.created_at) < now() - IN_FLIGHT_TIMEOUT_MS) {
        // Only that claim, and only while it is still without an outcome: one that has since finished is kept.
        await table()
          .delete()
          .eq("org_id", key.orgId)
          .eq("idempotency_key", idempotencyKey)
          .is("status", null)
          .eq("created_at", existing.created_at);
        continue;
      }
      if (existing.request_hash !== requestHash) {
        return apiError("conflict", "This Idempotency-Key was already used for a different request. Use a new key for a new request.");
      }
      if (existing.status === null) {
        return apiError("conflict", "The first request with this Idempotency-Key is still being handled. Repeat it in a moment.");
      }
      return NextResponse.json(existing.response, { status: existing.status, headers: { "Idempotent-Replayed": "true" } });
    }
    return apiError("conflict", "This Idempotency-Key could not be claimed. Repeat the request in a moment.");
  }
}
