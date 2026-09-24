import { supabase, unwrap } from "@/lib/supabase";
import { apiError, guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import {
  decodeCursor,
  paginate,
  parseLimit,
  type ApiCollection,
} from "@/lib/api/contract";
import {
  mapMilestone,
  milestoneStatusError,
  type MilestonePayload,
} from "@/lib/api/milestones";

export const dynamic = "force-dynamic";

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

  const status = url.searchParams.get("status");
  const statusError = milestoneStatusError(status);
  if (statusError) return apiError("invalid_request", statusError);
  const contractorId = url.searchParams.get("contractorId");

  return handleApiRequest(
    "GET /api/v1/milestones",
    async (): Promise<ApiCollection<MilestonePayload>> => {
      // Newest first: callers inspect current work; this is not a resumable log.
      let query = supabase()
        .from("milestones")
        .select(
          "id, title, amount, status, verification_source, verification_method, verification_status, verification_checked_at, verified_at, verification_detail, verified, decided_at, settled_at, agent_reasoning, tx_ref, created_at, counterparties(id, name, risk_level)"
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limitResult.limit + 1);

      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.k},and(created_at.eq.${cursor.k},id.lt.${cursor.id})`
        );
      }
      if (status) query = query.eq("status", status);
      if (contractorId) query = query.eq("contractor_id", contractorId);

      const rows = unwrap(await query) as unknown as Array<Record<string, unknown>>;
      const milestones = rows.map(mapMilestone);
      return paginate(milestones, limitResult.limit, (milestone) => ({
        k: milestone.createdAt,
        id: milestone.id,
      }));
    }
  );
}
