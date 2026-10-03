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
import {
  counterpartyFilterError,
  mapCounterparty,
  type CounterpartyPayload,
} from "@/lib/api/counterparties";
import { withIdempotency } from "@/lib/api/idempotency";
import { CreateCounterpartyBodySchema } from "@/lib/api/schemas";
import { invalidBody, readJsonBody } from "@/lib/api/write";
import { createCounterparty } from "@/lib/counterparties/create";
import { counterpartyInputSchema } from "@/lib/intake-validation";

export const dynamic = "force-dynamic";

const SELECT =
  "id, name, role, address, chain, jurisdiction, risk_level, risk_notes, baseline_payment_limit, payment_limit, last_screened_at, performance_score, performance_inputs, created_at";

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

  const role = url.searchParams.get("role");
  const roleError = counterpartyFilterError("role", role);
  if (roleError) return apiError("invalid_request", roleError);

  const riskLevel = url.searchParams.get("riskLevel");
  const riskError = counterpartyFilterError("riskLevel", riskLevel);
  if (riskError) return apiError("invalid_request", riskError);

  return handleApiRequest(
    "GET /api/v1/counterparties",
    guard.key,
    async (): Promise<ApiCollection<CounterpartyPayload>> => {
      // Newest first: this is a human-browsed book, not an append-only stream.
      let query = db()
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

/**
 * Adds a counterparty (docs/superpowers/specs/2026-10-03-write-api-design.md R2, R3): a read-and-write key's request,
 * checked against the console form's own rules, added through the same `createCounterparty` and screened. An address it
 * sets waits for a person to confirm it before the agent pays to it. The body is checked before an `Idempotency-Key` is
 * claimed, so a body that fails is never remembered (R5). The guard has read the issuer, who must still add records
 * (part 2, W5).
 */
export async function POST(request: Request) {
  const guard = await guardApiWrite(request);
  if ("denied" in guard) return guard.denied;
  const body = await readJsonBody(request);
  if ("denied" in body) return body.denied;

  const shape = CreateCounterpartyBodySchema.safeParse(body.value);
  if (!shape.success) return invalidBody(shape.error);
  const parsed = counterpartyInputSchema.safeParse({
    name: shape.data.name,
    role: shape.data.role,
    address: shape.data.address ?? "",
    chain: shape.data.chain ?? "ARC-TESTNET",
    jurisdiction: shape.data.jurisdiction ?? "",
    paymentLimit: shape.data.paymentLimit === undefined ? "" : String(shape.data.paymentLimit),
    noticeEmail: shape.data.noticeEmail ?? "",
  });
  if (!parsed.success) return invalidBody(parsed.error);

  return withIdempotency(request, guard.key, body.raw, () =>
    handleApiRequest("POST /api/v1/counterparties", guard.key, async () => {
      const created = await createCounterparty({ actorId: guard.actor.userId, counterparty: parsed.data, via: "api", apiKeyId: guard.key.keyId });
      const row = unwrap(await db().from("counterparties").select(SELECT).eq("id", created.id).single()) as Record<string, unknown>;
      return NextResponse.json({ data: mapCounterparty(row) }, { status: 201 });
    })
  );
}
