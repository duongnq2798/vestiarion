import { unwrap, type OrgDb } from "./dal";
import { ID_CHUNK } from "./new-payee-facts";
import type { IntentRecord } from "./settlement-facts";

/**
 * The payment intents a payment's lifecycle is read from (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md
 * L8), inside the workspace's organization scope: named columns, every one present since 0080, a page at a time. Read
 * only: the lifecycle writes nothing. A page calls these best effort, so a read that fails hides only the new parts.
 */

/** Exactly the columns `IntentRecord` names, with the payment's source, amount and token. */
export const INTENT_COLUMNS =
  "source_type, source_id, amount, token, status, provider, provider_mode, provider_tx_id, provider_state, failure_reason, last_error, tx_hash, mint_tx_hash, destination_chain, transfer_attempt, previous_attempts, submitted_at, executed_at, confirmed_at, created_at, updated_at, batch_key, network";

/** A payment intent as the lifecycle reads it, with what it pays and carries. */
export interface PaymentRecord extends IntentRecord {
  source_type: "invoice" | "milestone";
  source_id: string;
  amount: number;
  token: string;
}

type PaymentRow = Omit<PaymentRecord, "amount" | "token"> & { amount: number | string; token: string | null };

const PAGE = 1000;

/** Every row of a read, a page at a time; `read` orders its rows so the pages do not overlap. */
async function allRows(read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<PaymentRecord[]> {
  const rows: PaymentRecord[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(await read(from, from + PAGE - 1)) as PaymentRow[];
    rows.push(...page.map((row) => ({ ...row, amount: Number(row.amount), token: row.token ?? "USDC" })));
    if (page.length < PAGE) return rows;
  }
}

/** Bills & receivables: each invoice's payment intent, by invoice id (L8). */
export async function readInvoicePayments(orgDb: OrgDb): Promise<Map<string, PaymentRecord>> {
  const rows = await allRows((from, to) =>
    orgDb.from("payment_intents").select(INTENT_COLUMNS).eq("source_type", "invoice").order("source_id", { ascending: true }).range(from, to)
  );
  return new Map(rows.map((row) => [row.source_id, row]));
}

/** What `readIntentsFor` reads: each payment by the id of the invoice or milestone it pays, and where each was sent. */
export interface IntentsRead {
  payments: Map<string, PaymentRecord>;
  /**
   * Each payment's destination by the same id: an address, `blindpay:` for a bank payout, `sim:` for a simulated one.
   * Kept apart, never added to `IntentRecord`, so no other reader of the lifecycle carries it.
   */
  destinations: Map<string, string>;
}

/**
 * One counterparty's payments (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL9, CL13): the intents of
 * these invoices and milestones, with where each was sent, a hundred ids a read (`ID_CHUNK`) so no request's address
 * grows long enough to be refused. An invoice or a milestone has at most one intent, so no read is cut by the row cap.
 */
export async function readIntentsFor(orgDb: OrgDb, ids: { invoiceIds?: readonly string[]; milestoneIds?: readonly string[] }): Promise<IntentsRead> {
  const chunks = (["invoice", "milestone"] as const).flatMap((type) => {
    const sourceIds = [...new Set((type === "invoice" ? ids.invoiceIds : ids.milestoneIds) ?? [])];
    return Array.from({ length: Math.ceil(sourceIds.length / ID_CHUNK) }, (_, index) => ({ type, sourceIds: sourceIds.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK) }));
  });
  const read = await Promise.all(
    chunks.map(
      async ({ type, sourceIds }) =>
        unwrap(await orgDb.from("payment_intents").select(`${INTENT_COLUMNS}, destination`).eq("source_type", type).in("source_id", sourceIds)) as Array<
          PaymentRow & { destination?: string | null }
        >
    )
  );
  const payments = new Map<string, PaymentRecord>();
  const destinations = new Map<string, string>();
  for (const { destination, ...row } of read.flat()) {
    payments.set(row.source_id, { ...row, amount: Number(row.amount), token: row.token ?? "USDC" });
    if (typeof destination === "string" && destination) destinations.set(row.source_id, destination);
  }
  return { payments, destinations };
}

/**
 * Treasury: every payment intent not confirmed yet, and the confirmed intents of the bills someone comes back to (the
 * agent's cycle, or a person in Approvals or on Contractors: `followUpOf`), whose books may not have caught up (L8).
 */
export async function readPaymentsInFlight(orgDb: OrgDb, followedUp: readonly string[]): Promise<PaymentRecord[]> {
  const [open, confirmed] = await Promise.all([
    allRows((from, to) =>
      orgDb.from("payment_intents").select(INTENT_COLUMNS).neq("status", "confirmed").order("source_type", { ascending: true }).order("source_id", { ascending: true }).range(from, to)
    ),
    followedUp.length === 0
      ? Promise.resolve([])
      : allRows((from, to) =>
          orgDb
            .from("payment_intents")
            .select(INTENT_COLUMNS)
            .eq("status", "confirmed")
            .in("source_id", [...new Set(followedUp)])
            .order("source_type", { ascending: true })
            .order("source_id", { ascending: true })
            .range(from, to)
        ),
  ]);
  return [...open, ...confirmed];
}
