import { NextResponse } from "next/server";
import { db, platformDb, unwrap } from "@/lib/dal";
import { guardApiRequest, apiError, handleApiRequest } from "@/lib/api/guard";
import {
  decodeCursor,
  isTimestampCursor,
  paginate,
  parseLimit,
  type ApiCollection,
} from "@/lib/api/contract";
import { withIdempotency } from "@/lib/api/idempotency";
import { INVOICE_DIRECTIONS, INVOICE_SELECT, INVOICE_STATUSES, mapInvoice, type InvoicePayload } from "@/lib/api/invoices";
import { CreateInvoiceBodySchema } from "@/lib/api/schemas";
import { invalidBody, readJsonBody } from "@/lib/api/write";
import { runCycleSoon } from "@/lib/agent/cycle-soon";
import { invoiceInputSchema } from "@/lib/intake-validation";
import { createInvoice } from "@/lib/invoices/create";

export const dynamic = "force-dynamic";

const DIRECTIONS = new Set<string>(INVOICE_DIRECTIONS);
const STATUSES = new Set<string>(INVOICE_STATUSES);

/**
 * The payable and receivable book.
 *
 * The reference shape for every other collection: filter by enumerated values,
 * page by a stable key, and carry the agent's reasoning rather than only its
 * verdict. A bot that reports "this invoice was held" and cannot say why is
 * repeating a status; the reasoning is the product.
 *
 * Ordered newest first, because a list is read by a human deciding what to
 * look at. The ledger is the endpoint to resume from — see its note on why
 * ascending order is what makes a cursor a watermark.
 */
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

  // Rejected rather than ignored: a filter that silently does nothing returns
  // a plausible wrong answer, and a caller with a typo would never find out.
  const direction = url.searchParams.get("direction");
  if (direction && !DIRECTIONS.has(direction)) {
    return apiError("invalid_request", `direction must be one of ${[...DIRECTIONS].join(", ")}.`);
  }
  const status = url.searchParams.get("status");
  if (status && !STATUSES.has(status)) {
    return apiError("invalid_request", `status must be one of ${[...STATUSES].join(", ")}.`);
  }
  const counterpartyId = url.searchParams.get("counterpartyId");

  return handleApiRequest(
    "GET /api/v1/invoices",
    guard.key,
    async (): Promise<ApiCollection<InvoicePayload>> => {
      let query = db()
        .from("invoices")
        .select(INVOICE_SELECT)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limitResult.limit + 1);

      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.k},and(created_at.eq.${cursor.k},id.lt.${cursor.id})`
        );
      }
      if (direction) query = query.eq("direction", direction);
      if (status) query = query.eq("status", status);
      if (counterpartyId) query = query.eq("counterparty_id", counterpartyId);

      const rows = unwrap(await query) as unknown as Array<Record<string, unknown>>;
      const invoices = rows.map(mapInvoice);

      return paginate(invoices, limitResult.limit, (invoice) => ({
        k: invoice.createdAt,
        id: invoice.id,
      }));
    }
  );
}

/** The invoice form's fields as the API names them, where the two differ. */
const FORM_FIELDS = { earlyPayDiscountPct: "earlyPayDiscount.percent", discountDeadline: "earlyPayDiscount.deadline" };

/**
 * Adds an invoice (docs/superpowers/specs/2026-10-03-write-api-design.md R2, R4, R5): a read-and-write key's request,
 * checked against the invoice form's own rules and added through the same `createInvoice`, as the key's issuer's. The
 * agent decides it as one typed in, and a payable starts its cycle. The body is checked before an `Idempotency-Key` is
 * claimed, so a body that fails is never remembered. A counterparty the workspace does not hold is found only once the
 * write has started, so that answer is remembered (R5).
 */
export async function POST(request: Request) {
  const guard = await guardApiRequest(request, { scope: "write" });
  if ("denied" in guard) return guard.denied;
  const body = await readJsonBody(request);
  if ("denied" in body) return body.denied;

  const shape = CreateInvoiceBodySchema.safeParse(body.value);
  if (!shape.success) return invalidBody(shape.error);
  const { earlyPayDiscount } = shape.data;
  const parsed = invoiceInputSchema.safeParse({
    direction: shape.data.direction ?? "payable",
    counterpartyId: shape.data.counterpartyId,
    amount: String(shape.data.amount),
    currency: shape.data.currency,
    memo: shape.data.memo ?? "",
    poReference: shape.data.poReference ?? "",
    goodsReceived: shape.data.goodsReceived ?? false,
    dueDate: shape.data.dueDate,
    earlyPayDiscountPct: earlyPayDiscount ? String(earlyPayDiscount.percent) : "",
    discountDeadline: earlyPayDiscount?.deadline ?? "",
  });
  if (!parsed.success) return invalidBody(parsed.error, FORM_FIELDS);
  const invoice = parsed.data;

  return withIdempotency(request, guard.key, body.raw, () =>
    handleApiRequest("POST /api/v1/invoices", guard.key, async () => {
      const issuer = guard.key.createdBy;
      // Read before anything is written, so a failure here answers 500 with nothing added, and a retry is safe (R5).
      const workspace =
        invoice.direction === "payable" && issuer
          ? (unwrap(await platformDb().from("orgs").select("mode").eq("id", guard.key.orgId).single()) as { mode: string })
          : null;

      const created = await createInvoice({ actorId: issuer, invoice, document: null, via: "api", apiKeyId: guard.key.keyId });
      if (!created) return apiError("invalid_request", "counterpartyId: No counterparty with this id in this workspace.");
      // A payable starts the agent's cycle, as one typed in does. With its issuer's account gone, the schedule takes it.
      if (workspace && issuer) {
        runCycleSoon({ orgId: guard.key.orgId, userId: issuer, sandbox: workspace.mode === "sandbox", kind: "invoice_added" });
      }

      const row = unwrap(await db().from("invoices").select(INVOICE_SELECT).eq("id", created.id).single()) as Record<string, unknown>;
      return NextResponse.json({ data: mapInvoice(row) }, { status: 201 });
    })
  );
}
