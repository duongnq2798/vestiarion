import crypto from "node:crypto";
import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { assertLedgerCanSign } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { networkProfile } from "../network";
import { workspaceNetwork } from "../workspace-network";
import {
  ALLOCATION_COLUMNS,
  PAYMENT_COLUMNS,
  RECEIVABLE_COLUMNS,
  readAllocationRows,
  toAllocationRow,
  toPaymentIn,
  toReceivableIn,
  type AllocationDbRow,
  type PaymentDbRow,
} from "./book";
import {
  AllocationError,
  allocationErrorFromDb,
  amountWords,
  fromMicros,
  parseAmount,
  paymentBalance,
  planApplication,
  planReversal,
  receivableBalance,
  type AllocationRow,
  type PaymentIn,
  type PlannedRow,
  type ReceivableIn,
} from "./model";
import { receivableLabel, type SuggestionRule } from "./suggest";

/**
 * Applying a payment, recording a fee and reversing either, written (docs/superpowers/specs/2026-10-12-allocations-
 * design.md L5, L7, L8, L12). Each reads what it needs now, plans the rows with the pure model, so a refusal reads in
 * plain words before anything is written, checks the signing key, writes every row in one insert (the trigger of 0103
 * holds the invariants however many people act at once), then signs one entry per row, best effort, as every recorded
 * change is. Every export runs inside an organization scope; who may do it (`receivables.reconcile`) is the command's check.
 */

export const ALLOCATION_ACTIONS = { payment: "ar_payment_applied", fee: "ar_fee_recorded", reversal: "ar_allocation_reversed" } as const;

export interface ApplyInput {
  actorId: string;
  paymentId: string | null;
  /** The payment's version as the person read it; required with a payment. */
  version: number | null;
  lines: ReadonlyArray<{ invoiceId: string; amount: string }>;
  fees: ReadonlyArray<{ invoiceId: string; amount: string; reason: string }>;
  /** The suggestion the person confirmed, when they confirmed one. */
  suggestion?: { rule: SuggestionRule; why: string } | null;
}

export interface WrittenRow {
  id: string;
  kind: AllocationRow["kind"];
  invoiceId: string;
  amount: number;
  currency: string;
  label: string;
  customer: string;
  outstandingAfter: number;
}

export interface ApplyResult {
  rows: WrittenRow[];
  /** What is left of the payment; 0 with no payment. */
  unappliedAfter: number;
  currency: string | null;
  customer: string | null;
}

async function readPayment(paymentId: string): Promise<PaymentIn> {
  const rows = unwrap(await db().from("incoming_transfers").select(PAYMENT_COLUMNS).eq("id", paymentId).limit(1)) as PaymentDbRow[];
  if (!rows[0]) throw new AllocationError("no_payment");
  return toPaymentIn(rows[0]);
}

async function readReceivables(ids: readonly string[]): Promise<ReceivableIn[]> {
  if (ids.length === 0) return [];
  const rows = unwrap(await db().from("invoices").select(RECEIVABLE_COLUMNS).in("id", [...ids])) as unknown as Array<Parameters<typeof toReceivableIn>[0] & { direction: string }>;
  return rows.filter((row) => row.direction === "receivable").map(toReceivableIn);
}

async function wholeMatchedAmong(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = unwrap(await db().from("incoming_transfers").select("invoice_id").in("invoice_id", [...ids])) as Array<{ invoice_id: string }>;
  return new Set(rows.map((row) => row.invoice_id));
}

function amountOf(typed: string): number {
  const micros = parseAmount(typed);
  if (micros === null) throw new AllocationError("amount");
  return micros;
}

async function insertRows(planned: readonly PlannedRow[], actorId: string | null): Promise<AllocationRow[]> {
  const write = await db()
    .from("receivable_allocations")
    .insert(
      planned.map((row) => ({
        kind: row.kind,
        invoice_id: row.invoiceId,
        transfer_id: row.transferId,
        amount: fromMicros(row.amount),
        currency: row.currency,
        reason: row.reason,
        basis: row.kind === "payment" ? (row.basis ?? "person") : null,
        reverses: row.reverses ?? null,
        payment_seq: row.paymentSeq,
        created_by: actorId,
      }))
    )
    .select(ALLOCATION_COLUMNS);
  if (write.error) {
    const known = allocationErrorFromDb(write.error);
    if (known) throw known;
    throw new Error(write.error.message);
  }
  return ((write.data ?? []) as AllocationDbRow[]).map(toAllocationRow);
}

const units = (micros: number) => fromMicros(micros);

export async function applyPayment(input: ApplyInput): Promise<ApplyResult> {
  const lines = input.lines.map((line) => ({ invoiceId: line.invoiceId, amount: amountOf(line.amount) }));
  const fees = input.fees.map((fee) => ({ invoiceId: fee.invoiceId, amount: amountOf(fee.amount), reason: fee.reason }));
  const payment = input.paymentId ? await readPayment(input.paymentId) : null;
  const touched = [...new Set([...lines, ...fees].map((line) => line.invoiceId))];

  const rows = await readAllocationRows(db(), { invoiceIds: touched, transferIds: payment ? [payment.id] : [] });
  if (rows === null) throw new AllocationError("not_ready");
  const named = [...new Set([...touched, ...rows.map((row) => row.invoiceId)])];
  const [receivables, wholeMatched] = await Promise.all([readReceivables(named), wholeMatchedAmong(touched)]);

  const plan = planApplication({ payment, version: payment ? input.version : null, lines, fees }, { receivables, rows, wholeMatched }, "person");
  if (!plan.ok) throw new AllocationError(plan.code);
  // An unreadable signing key refuses the application before its rows are written, rather than leave them unsigned.
  assertLedgerCanSign();
  const written = await insertRows(plan.rows, input.actorId);

  const byId = new Map(receivables.map((receivable) => [receivable.id, receivable]));
  const group = crypto.randomUUID();
  const { label: network } = networkProfile(workspaceNetwork().id);
  const result: WrittenRow[] = [];
  for (const row of written) {
    const receivable = byId.get(row.invoiceId) as ReceivableIn;
    const outstandingAfter = plan.outstandingAfter.get(row.invoiceId) ?? 0;
    const label = receivableLabel(receivable);
    const owed = outstandingAfter === 0 ? "now paid" : `${amountWords(outstandingAfter, row.currency)} still owed`;
    const fee = row.kind === "fee";
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "human",
      domain: "ar",
      action: fee ? ALLOCATION_ACTIONS.fee : ALLOCATION_ACTIONS.payment,
      summary: fee
        ? `Recorded ${amountWords(row.amount, row.currency)} as a fee on ${label} from ${receivable.customer}: ${row.reason} (${owed})`
        : `Applied ${amountWords(row.amount, row.currency)} received on ${network} to ${label} from ${receivable.customer} (${owed})`,
      detail: {
        by: input.actorId,
        allocationId: row.id,
        invoiceId: row.invoiceId,
        counterpartyId: receivable.counterpartyId,
        transferId: row.transferId,
        amount: units(row.amount),
        currency: row.currency,
        txHash: fee ? null : (payment?.txHash ?? null),
        from: fee ? null : (payment?.from ?? null),
        basis: row.basis,
        outstandingAfter: units(outstandingAfter),
        unappliedAfter: payment ? units(plan.unappliedAfter) : null,
        group,
        ...(fee ? { reason: row.reason } : {}),
        ...(input.suggestion ? { suggestion: { rule: input.suggestion.rule, why: input.suggestion.why } } : {}),
      },
    });
    result.push({ id: row.id, kind: row.kind, invoiceId: row.invoiceId, amount: row.amount, currency: row.currency, label, customer: receivable.customer, outstandingAfter });
  }
  const customer = lines[0] ? (byId.get(lines[0].invoiceId)?.customer ?? null) : null;
  return { rows: result, unappliedAfter: payment ? plan.unappliedAfter : 0, currency: payment?.currency ?? null, customer };
}

export interface ReverseResult {
  rows: WrittenRow[];
  /** The reversed row's receivable, as it stands after. */
  invoiceId: string;
  outstandingAfter: number;
  currency: string;
  label: string;
}

export async function reverseAllocation(input: { actorId: string; allocationId: string; reason: string }): Promise<ReverseResult> {
  const found = await db().from("receivable_allocations").select(ALLOCATION_COLUMNS).eq("id", input.allocationId).limit(1);
  if (found.error) {
    const known = allocationErrorFromDb(found.error);
    if (known) throw known;
    throw new Error(found.error.message);
  }
  const target = ((found.data ?? []) as AllocationDbRow[]).map(toAllocationRow)[0];
  if (!target) throw new AllocationError("not_found");
  const rows = (await readAllocationRows(db(), { invoiceIds: [target.invoiceId], transferIds: target.transferId ? [target.transferId] : [] })) ?? [];
  const plan = planReversal({ allocationId: target.id, reason: input.reason }, rows);
  if (!plan.ok) throw new AllocationError(plan.code);
  assertLedgerCanSign();

  const [receivable] = await readReceivables([target.invoiceId]);
  if (!receivable) throw new AllocationError("not_found");
  const payment = target.transferId ? await readPayment(target.transferId) : null;
  const written = await insertRows(plan.rows, input.actorId);
  const after = [...rows, ...written];
  // The status as the trigger left it: a reversal reopens a receivable it had settled.
  const reopened = { ...receivable, status: receivable.status === "received" && receivableBalance({ ...receivable, status: "pending" }, after, false).outstanding > 0 ? "pending" : receivable.status };
  const balance = receivableBalance(reopened, after, false);
  const label = receivableLabel(receivable);
  const unappliedAfter = payment ? paymentBalance(payment, after, new Map([[receivable.id, receivable]])).unapplied : null;
  const group = crypto.randomUUID();
  const result: WrittenRow[] = [];
  for (const row of written) {
    const original = rows.find((candidate) => candidate.id === row.reverses);
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "human",
      domain: "ar",
      action: ALLOCATION_ACTIONS.reversal,
      summary: `Reversed ${amountWords(row.amount, row.currency)} ${original?.kind === "fee" ? "recorded as a fee" : "applied"} on ${label} from ${receivable.customer}: ${row.reason} (${amountWords(balance.outstanding, row.currency)} still owed)`,
      detail: {
        by: input.actorId,
        allocationId: row.id,
        reverses: row.reverses,
        reversedKind: original?.kind ?? null,
        invoiceId: row.invoiceId,
        counterpartyId: receivable.counterpartyId,
        transferId: row.transferId,
        amount: units(row.amount),
        currency: row.currency,
        txHash: row.transferId ? (payment?.txHash ?? null) : null,
        reason: row.reason,
        outstandingAfter: units(balance.outstanding),
        unappliedAfter: row.transferId && unappliedAfter !== null ? units(unappliedAfter) : null,
        group,
      },
    });
    result.push({ id: row.id, kind: row.kind, invoiceId: row.invoiceId, amount: row.amount, currency: row.currency, label, customer: receivable.customer, outstandingAfter: balance.outstanding });
  }
  return { rows: result, invoiceId: receivable.id, outstandingAfter: balance.outstanding, currency: receivable.currency, label };
}
