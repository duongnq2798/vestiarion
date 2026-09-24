import { supabase, unwrap } from "@/lib/supabase";
import { apiError, guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import {
  decodeCursor,
  paginate,
  parseLimit,
  type ApiCollection,
} from "@/lib/api/contract";
import {
  counterpartyFilterError,
  mapCounterparty,
  type CounterpartyPayload,
} from "@/lib/api/counterparties";

export const dynamic = "force-dynamic";

const SELECT =
  "id, name, role, address, chain, jurisdiction, risk_level, risk_notes, baseline_payment_limit, payment_limit, last_screened_at, performance_score, performance_inputs, created_at";

export async function GET(request: Request) {
  const denied = guardApiRequest(request, { scope: "read" });
  if (denied) return denied;

  const url = new URL(request.url);
  const limitResult = parseLimit(url.searchParams.get("limit"));
  if ("error" in limitResult) return apiError("invalid_request", limitResult.error);

  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    return apiError("invalid_request", "cursor is not a cursor this API issued.");
  }
  if (cursor && (typeof cursor.k !== "string" || !cursor.id)) {
    return apiError("invalid_request", "cursor is not valid for this endpoint.");
  }

  const role = url.searchParams.get("role");
  const roleError = counterpartyFilterError("role", role);
  if (roleError) return apiError("invalid_request", roleError);

  const riskLevel = url.searchParams.get("riskLevel");
  const riskError = counterpartyFilterError("riskLevel", riskLevel);
  if (riskError) return apiError("invalid_request", riskError);

  return handleApiRequest(
    "GET /api/v1/counterparties",
    async (): Promise<ApiCollection<CounterpartyPayload>> => {
      // Newest first: this is a human-browsed book, not an append-only stream.
      let query = supabase()
        .from("counterparties")
        .select(SELECT)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limitResult.limit + 1);

      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.k},and(created_at.eq.${cursor.k},id.lt.${cursor.id})`
        );
      }
      if (role) query = query.eq("role", role);
      if (riskLevel) query = query.eq("risk_level", riskLevel);

      const rows = unwrap(await query) as Array<Record<string, unknown>>;
      const counterparties = rows.map(mapCounterparty);
      return paginate(counterparties, limitResult.limit, (counterparty) => ({
        k: counterparty.createdAt,
        id: counterparty.id,
      }));
    }
  );
}
