import { siteOrigin } from "../auth/env";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { inForce } from "../deals/lines";
import { readDeals, type DealRecord } from "../deals/read";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { networkOf, type Network } from "../network";
import { isNotSetUp, NotSetUpError } from "./connections";
import { dealCollection, evidenceUrl, readConflicts, readReceiptFields, receiptFields, type AppliedPayment, type DealReceivable, type ReceiptFields } from "./crm-receipts";
import type { LinkedDealFields, ReceiptStore, ReceiptWriteRow, WritePatch, WriteState } from "./crm-receipts-run";

/**
 * The receipts' database (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R1, R5, R7), in the workspace's own
 * scope through the DAL: the deals planned from the CRM with what they collected, read from their receivables, the
 * money applied to them and the payments that brought it; and the outbox of writes (`crm_receipt_writes`, migration
 * 0107). Before 0107 has run, every read says it is not set up. No token is read here.
 */

export const WRITE_COLUMNS =
  "id, connection_id, crm_deal_id, deal_id, external_deal_id, fields, network, shadow, account_type, account_test, state, reason, message, attempts, next_attempt_at, sending_until, conflicts, overwrite, overwrite_by, overwrite_at, read_back, sent_at, written_at, created_at";

export interface WriteDbRow {
  id: string;
  connection_id: string;
  crm_deal_id: string;
  deal_id: string;
  external_deal_id: string;
  fields: unknown;
  network: string;
  shadow: boolean;
  account_type: string | null;
  account_test: boolean | null;
  state: WriteState;
  reason: string | null;
  message: string | null;
  attempts: number;
  next_attempt_at: string | null;
  sending_until: string | null;
  conflicts: unknown;
  overwrite: unknown;
  overwrite_by: string | null;
  overwrite_at: string | null;
  read_back: unknown;
  sent_at: string | null;
  written_at: string | null;
  created_at: string;
}

const EMPTY = readReceiptFields({}) as ReceiptFields;

function textRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function toWrite(row: WriteDbRow): ReceiptWriteRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    crmDealId: row.crm_deal_id,
    dealId: row.deal_id,
    externalDealId: row.external_deal_id,
    fields: readReceiptFields(row.fields) ?? EMPTY,
    network: networkOf(row.network),
    shadow: row.shadow,
    accountType: row.account_type,
    accountTest: row.account_test,
    state: row.state,
    reason: row.reason,
    message: row.message,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at,
    sendingUntil: row.sending_until,
    conflicts: readConflicts(row.conflicts),
    overwrite: textRecord(row.overwrite),
    overwriteBy: row.overwrite_by,
    overwriteAt: row.overwrite_at,
    readBack: row.read_back === null ? null : readReceiptFields(row.read_back),
    sentAt: row.sent_at,
    writtenAt: row.written_at,
    createdAt: row.created_at,
  };
}

function raise(error: { code?: string | null; message: string }): never {
  if (isNotSetUp(error)) throw new NotSetUpError();
  throw new Error(error.message);
}

function patchColumns(patch: Partial<WritePatch>): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  const map: Record<keyof WritePatch, string> = {
    reason: "reason",
    message: "message",
    attempts: "attempts",
    nextAttemptAt: "next_attempt_at",
    sendingUntil: "sending_until",
    conflicts: "conflicts",
    overwrite: "overwrite",
    overwriteBy: "overwrite_by",
    overwriteAt: "overwrite_at",
    readBack: "read_back",
    sentAt: "sent_at",
    writtenAt: "written_at",
    accountType: "account_type",
    accountTest: "account_test",
  };
  for (const [key, column] of Object.entries(map) as Array<[keyof WritePatch, string]>) {
    if (patch[key] !== undefined) columns[column] = patch[key];
  }
  return columns;
}

/** Whether writing is on for a connection (0107), or null before 0107 has run: nothing is written then. */
export async function writesSwitch(connectionId: string): Promise<{ on: boolean; by: string | null; at: string | null } | null> {
  const result = await db().from("accounting_connections").select("writes_on, writes_by, writes_at").eq("id", connectionId).limit(1);
  if (result.error) {
    if (isNotSetUp(result.error) || result.error.code === "42703" || result.error.code === "PGRST204" || /writes_on/.test(result.error.message ?? "")) return null;
    throw new Error(result.error.message);
  }
  const row = ((result.data ?? []) as Array<{ writes_on: boolean; writes_by: string | null; writes_at: string | null }>)[0];
  return row ? { on: row.writes_on === true, by: row.writes_by, at: row.writes_at } : null;
}

/** Every row of a read of ids, a hundred ids at a time. */
async function byIds<T>(ids: readonly string[], read: (batch: string[]) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let at = 0; at < ids.length; at += 100) {
    const result = await read(ids.slice(at, at + 100));
    if (result.error) raise(result.error);
    rows.push(...((result.data ?? []) as T[]));
  }
  return rows;
}

interface ReceivableRow {
  id: string;
  deal_id: string;
  amount: number | string;
  currency: string | null;
  status: string;
  due_date: string;
  original_currency: string | null;
  original_amount: number | string | null;
}

interface AllocationDbRow {
  id: string;
  kind: "payment" | "fee" | "reversal";
  invoice_id: string;
  transfer_id: string | null;
  amount: number | string;
  reverses: string | null;
}

interface TransferRow {
  id: string;
  invoice_id: string | null;
  amount: number | string;
  received_at: string;
  tx_hash: string | null;
  chain: string;
}

/**
 * What each deal collected (R1), from records already read: its receivables, the live allocations on them, and the
 * payments that arrived on Arc and were applied, whole or in part.
 */
export function dealFields(input: {
  deal: DealRecord;
  receivables: readonly ReceivableRow[];
  allocations: readonly AllocationDbRow[];
  transfers: ReadonlyMap<string, TransferRow>;
  wholeMatches: readonly TransferRow[];
  today: string;
  evidence: string;
}): ReceiptFields {
  const { deal } = input;
  const own = input.receivables.filter((row) => row.deal_id === deal.facts.id);
  const ids = new Set(own.map((row) => row.id));
  const rows = input.allocations.filter((row) => ids.has(row.invoice_id));
  const reversed = new Set(rows.flatMap((row) => (row.kind === "reversal" && row.reverses ? [row.reverses] : [])));
  const live = rows.filter((row) => row.kind !== "reversal" && !reversed.has(row.id));
  const receivables: DealReceivable[] = own.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency ?? "USDC",
    status: row.status,
    dueOn: String(row.due_date).slice(0, 10),
    originalCurrency: row.original_currency,
    originalAmount: row.original_amount === null ? null : Number(row.original_amount),
  }));
  const payments: AppliedPayment[] = [];
  for (const row of live) {
    if (row.kind !== "payment" || !row.transfer_id) continue;
    const transfer = input.transfers.get(row.transfer_id);
    if (!transfer) continue;
    payments.push({ transferId: transfer.id, invoiceId: row.invoice_id, amount: Number(row.amount), receivedAt: transfer.received_at, txHash: transfer.tx_hash, chain: transfer.chain });
  }
  // A whole match settled its receivable with all of the payment (0050): what the receivable asked.
  for (const transfer of input.wholeMatches) {
    const receivable = receivables.find((row) => row.id === transfer.invoice_id);
    if (!receivable || (receivable.status !== "received" && receivable.status !== "paid")) continue;
    payments.push({ transferId: transfer.id, invoiceId: receivable.id, amount: receivable.amount, receivedAt: transfer.received_at, txHash: transfer.tx_hash, chain: transfer.chain });
  }
  const fees = live.filter((row) => row.kind === "fee").map((row) => ({ invoiceId: row.invoice_id, amount: Number(row.amount) }));
  const notInvoicedMinor = inForce(deal.facts.lines)
    .filter((line) => line.status === "planned" && line.kind === "charge")
    .reduce((sum, line) => sum + line.amountMinor, 0);
  const collection = dealCollection({
    deal: { currency: deal.facts.currency, digits: deal.digits, status: deal.facts.status },
    receivables,
    payments,
    fees,
    notInvoicedMinor,
    today: input.today,
  });
  return receiptFields(collection, input.evidence);
}

/** The workspace's slug, for the evidence link. */
async function workspaceSlug(): Promise<string> {
  const found = await platformDb().from("orgs").select("slug").eq("id", currentOrgId()).limit(1);
  if (found.error) throw new Error(found.error.message);
  const slug = ((found.data ?? []) as Array<{ slug: string }>)[0]?.slug;
  if (!slug) throw new Error("the workspace has no slug");
  return slug;
}

export const receiptStore: ReceiptStore = {
  async linkedDeals(connection) {
    const linked = unwrap(
      await db().from("crm_deals").select("id, external_id, deal_id").eq("connection_id", connection.id).not("deal_id", "is", null).eq("source_status", "present").limit(500)
    ) as Array<{ id: string; external_id: string; deal_id: string }>;
    if (linked.length === 0) return [];
    const read = await readDeals();
    if (!read.available) return [];
    const deals = read.deals.filter((deal) => linked.some((row) => row.deal_id === deal.facts.id));
    const dealIds = deals.map((deal) => deal.facts.id);
    const receivables = await byIds<ReceivableRow>(dealIds, (batch) =>
      db().from("invoices").select("id, deal_id, amount, currency, status, due_date, original_currency, original_amount").in("deal_id", batch).eq("direction", "receivable")
    );
    const receivableIds = receivables.map((row) => row.id);
    const [allocations, wholeMatches, shadow] = await Promise.all([
      byIds<AllocationDbRow>(receivableIds, (batch) => db().from("receivable_allocations").select("id, kind, invoice_id, transfer_id, amount, reverses").in("invoice_id", batch)),
      byIds<TransferRow>(receivableIds, (batch) => db().from("incoming_transfers").select("id, invoice_id, amount, received_at, tx_hash, chain").in("invoice_id", batch)),
      db().from("shadow_modes").select("org_id").limit(1),
    ]);
    const transferIds = [...new Set(allocations.flatMap((row) => (row.transfer_id ? [row.transfer_id] : [])))];
    const transfers = new Map(
      (await byIds<TransferRow>(transferIds, (batch) => db().from("incoming_transfers").select("id, invoice_id, amount, received_at, tx_hash, chain").in("id", batch))).map((row) => [row.id, row])
    );
    const shadowOn = !shadow.error && (shadow.data ?? []).length > 0;
    const network: Network = networkOf(currentOrgConfig().network);
    const slug = await workspaceSlug();
    const today = new Date().toISOString().slice(0, 10);
    return linked.flatMap((row): LinkedDealFields[] => {
      const deal = deals.find((candidate) => candidate.facts.id === row.deal_id);
      if (!deal) return [];
      const own = receivables.filter((receivable) => receivable.deal_id === deal.facts.id);
      return [
        {
          crmDealId: row.id,
          dealId: deal.facts.id,
          externalDealId: row.external_id,
          title: deal.title,
          fields: dealFields({ deal, receivables, allocations, transfers, wholeMatches, today, evidence: evidenceUrl(siteOrigin(), slug, deal.facts.id) }),
          network,
          // Shadow mode, or a deal in the business's own currency, whose invoices only shadow mode converts (D3).
          shadow: shadowOn || own.some((receivable) => receivable.original_currency !== null) || !["USDC", "EURC"].includes(deal.facts.currency),
        },
      ];
    });
  },

  async latest(connectionId, crmDealIds) {
    if (crmDealIds.length === 0) return new Map();
    const rows = await byIds<WriteDbRow>(crmDealIds, (batch) =>
      db().from("crm_receipt_writes").select(WRITE_COLUMNS).eq("connection_id", connectionId).in("crm_deal_id", batch).neq("state", "superseded").order("created_at", { ascending: false })
    );
    const latest = new Map<string, ReceiptWriteRow>();
    for (const row of rows) if (!latest.has(row.crm_deal_id)) latest.set(row.crm_deal_id, toWrite(row));
    return latest;
  },

  async owned(crmDealId) {
    const result = await db().from("crm_receipt_writes").select("read_back").eq("crm_deal_id", crmDealId).eq("state", "written").order("written_at", { ascending: false }).limit(1);
    if (result.error) raise(result.error);
    const row = ((result.data ?? []) as Array<{ read_back: unknown }>)[0];
    return row ? readReceiptFields(row.read_back) : null;
  },

  async insert(connection, deal) {
    const result = await db()
      .from("crm_receipt_writes")
      .insert({
        connection_id: connection.id,
        crm_deal_id: deal.crmDealId,
        deal_id: deal.dealId,
        provider: connection.provider,
        external_org_id: connection.externalOrgId,
        external_deal_id: deal.externalDealId,
        fields: deal.fields,
        network: deal.network,
        shadow: deal.shadow,
      })
      .select(WRITE_COLUMNS);
    if (result.error) {
      // Another write is in hand for the deal (a run a moment before): this one waits for the next run.
      if (result.error.code === "23505") return null;
      raise(result.error);
    }
    const row = ((result.data ?? []) as unknown as WriteDbRow[])[0];
    return row ? toWrite(row) : null;
  },

  async move(row, from, to, patch, options) {
    let query = db()
      .from("crm_receipt_writes")
      .update({ state: to, ...patchColumns(patch) })
      .eq("id", row.id);
    const others = from.filter((state) => state !== "sending");
    if (from.includes("sending") && options?.leaseOverAt) {
      // A claim takes a write being sent only once that send's lease ran out.
      const lease = `and(state.eq.sending,or(sending_until.is.null,sending_until.lte.${options.leaseOverAt}))`;
      query = query.or(others.length > 0 ? `state.in.(${others.join(",")}),${lease}` : lease);
    } else {
      query = query.in("state", [...from]);
    }
    if (patch.attempts !== undefined) query = query.eq("attempts", row.attempts);
    const result = await query.select(WRITE_COLUMNS);
    if (result.error) raise(result.error);
    const moved = ((result.data ?? []) as unknown as WriteDbRow[])[0];
    return moved ? toWrite(moved) : null;
  },

  async due(connectionId, nowIso, limit) {
    const result = await db()
      .from("crm_receipt_writes")
      .select(WRITE_COLUMNS)
      .eq("connection_id", connectionId)
      .or(`state.in.(queued,sent),and(state.eq.failed,or(next_attempt_at.is.null,next_attempt_at.lte.${nowIso})),and(state.eq.sending,or(sending_until.is.null,sending_until.lte.${nowIso}))`)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (result.error) raise(result.error);
    return ((result.data ?? []) as unknown as WriteDbRow[]).map(toWrite);
  },

  async record(entry) {
    await appendLedgerEntryBestEffort(currentOrgId(), entry);
  },
};
