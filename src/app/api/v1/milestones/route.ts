import { NextResponse } from "next/server";
import { db, unwrap } from "@/lib/dal";
import { apiError, guardApiRequest, guardApiWrite, handleApiRequest } from "@/lib/api/guard";
import {
  decodeCursor,
  isTimestampCursor,
  paginate,
  parseLimit,
  type ApiCollection,
} from "@/lib/api/contract";
import { withIdempotency } from "@/lib/api/idempotency";
import {
  MILESTONE_SELECT,
  mapMilestone,
  milestoneStatusError,
  type MilestonePayload,
} from "@/lib/api/milestones";
import { CreateMilestoneBodySchema } from "@/lib/api/schemas";
import { invalidBody, readJsonBody, refusalResponse } from "@/lib/api/write";
import { addMilestone } from "@/lib/commands/milestones";
import { milestoneInputSchema } from "@/lib/intake-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const url = new URL(request.url);
  const limitResult = parseLimit(url.searchParams.get("limit"));
  if ("error" in limitResult) return apiError("invalid_request", limitResult.error);

  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    return apiError("invalid_request", "cursor is not a cursor this API issued.");
  }
  if (cursor && !isTimestampCursor(cursor)) {
    return apiError("invalid_request", "cursor is not valid for this endpoint.");
  }

  const status = url.searchParams.get("status");
  const statusError = milestoneStatusError(status);
  if (statusError) return apiError("invalid_request", statusError);
  const contractorId = url.searchParams.get("contractorId");

  return handleApiRequest(
    "GET /api/v1/milestones",
    guard.key,
    async (): Promise<ApiCollection<MilestonePayload>> => {
      // Newest first: callers inspect current work; this is not a resumable log.
      let query = db()
        .from("milestones")
        .select(MILESTONE_SELECT)
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

/** The milestone form's fields as the API names them, where the two differ. */
const FORM_FIELDS = { evidence: "verificationSource" };

/** What each of `addMilestone`'s own refusals answers: the body named a contractor it cannot be. */
const REFUSALS = {
  contractor_not_found: "contractorId: No counterparty with this id in this workspace.",
  client: "contractorId: A client is not paid for milestones. Use a contractor or a vendor.",
};

/**
 * Adds a milestone (docs/superpowers/specs/2026-10-03-write-api-part-2-design.md W1, W2): a read-and-write key's
 * request, checked against the console form's own rules and added through the same `addMilestone`, as the key's
 * issuer's. It starts pending: GitHub or a person verifies it, never the API. The body is checked before an
 * `Idempotency-Key` is claimed, so a body that fails is never remembered; a contractor the workspace does not hold, or a
 * client, is found once the write has started, so that answer is remembered (part 1, R5).
 */
export async function POST(request: Request) {
  const guard = await guardApiWrite(request);
  if ("denied" in guard) return guard.denied;
  const body = await readJsonBody(request);
  if ("denied" in body) return body.denied;

  const shape = CreateMilestoneBodySchema.safeParse(body.value);
  if (!shape.success) return invalidBody(shape.error);
  const parsed = milestoneInputSchema.safeParse({
    contractorId: shape.data.contractorId,
    title: shape.data.title,
    amount: String(shape.data.amount),
    evidence: shape.data.verificationSource ?? "",
  });
  if (!parsed.success) return invalidBody(parsed.error, FORM_FIELDS);
  const milestone = parsed.data;

  return withIdempotency(request, guard.key, body.raw, () =>
    handleApiRequest("POST /api/v1/milestones", guard.key, async () => {
      const added = await addMilestone(guard.actor, { milestone });
      if (!added.ok) return refusalResponse(added, REFUSALS);
      const row = unwrap(await db().from("milestones").select(MILESTONE_SELECT).eq("id", added.milestoneId).single()) as Record<string, unknown>;
      return NextResponse.json({ data: mapMilestone(row) }, { status: 201 });
    })
  );
}
