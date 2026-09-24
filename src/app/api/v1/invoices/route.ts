import { supabase, unwrap } from "@/lib/supabase";
import { guardApiRequest, apiError, handleApiRequest } from "@/lib/api/guard";
import {
  decodeCursor,
  paginate,
  parseLimit,
  type ApiCollection,
} from "@/lib/api/contract";

export const dynamic = "force-dynamic";

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
export interface InvoicePayload {
  id: string;
  direction: "payable" | "receivable";
  status: string;
  amount: number;
  currency: string;
  memo: string | null;
  poReference: string | null;
  goodsReceived: boolean;
  dueDate: string;
  decidedAt: string | null;
  settledAt: string | null;
  escalatedAt: string | null;
  /** Why the agent ruled as it did, verbatim from the decision. */
  agentReasoning: string | null;
  /** An on-chain hash when the payment settled on Arc, else null. */
  txHash: string | null;
  counterparty: { id: string; name: string; riskLevel: string } | null;
  createdAt: string;
}

const DIRECTIONS = new Set(["payable", "receivable"]);
const STATUSES = new Set([
  "pending", "matched", "paid", "held", "flagged", "awaiting_info", "received", "rejected",
]);

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
    async (): Promise<ApiCollection<InvoicePayload>> => {
      let query = supabase()
        .from("invoices")
        .select(
          "id, direction, status, amount, currency, memo, po_reference, goods_received, due_date, decided_at, settled_at, escalated_at, agent_reasoning, tx_ref, created_at, counterparties(id, name, risk_level)"
        )
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

      const invoices: InvoicePayload[] = rows.map((row) => {
        const embedded = row.counterparties as
          | { id: string; name: string; risk_level: string }
          | null;
        const txRef = row.tx_ref == null ? null : String(row.tx_ref);
        return {
          id: String(row.id),
          direction: row.direction as InvoicePayload["direction"],
          status: String(row.status),
          amount: Number(row.amount),
          currency: String(row.currency ?? "USDC"),
          memo: row.memo == null ? null : String(row.memo),
          poReference: row.po_reference == null ? null : String(row.po_reference),
          goodsReceived: row.goods_received === true,
          dueDate: String(row.due_date),
          decidedAt: row.decided_at == null ? null : String(row.decided_at),
          settledAt: row.settled_at == null ? null : String(row.settled_at),
          escalatedAt: row.escalated_at == null ? null : String(row.escalated_at),
          agentReasoning: row.agent_reasoning == null ? null : String(row.agent_reasoning),
          // Only a real chain hash is reported as one. A simulated reference
          // is not a transaction anybody can look up.
          txHash: txRef?.startsWith("0x") ? txRef : null,
          counterparty: embedded
            ? { id: embedded.id, name: embedded.name, riskLevel: embedded.risk_level }
            : null,
          createdAt: String(row.created_at),
        };
      });

      return paginate(invoices, limitResult.limit, (invoice) => ({
        k: invoice.createdAt,
        id: invoice.id,
      }));
    }
  );
}
