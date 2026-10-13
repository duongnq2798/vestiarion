import { db, type OrgDb } from "../dal";
import { collectionOfRows, type AllocationDbRow, type Collection, type ReceivableRow, type TransferRow } from "./collection";
import type { DealRecord } from "./read";

/**
 * What each deal collected (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R1), read in the workspace's own
 * scope: the deals' receivables, the allocations on them (0103), and the payments that arrived on Arc behind both, whole
 * matches (0050) included. The one read behind a deal page's Paid and Outstanding, the Deals list and the receipts
 * written back to a CRM.
 */

export interface DealCollected {
  collection: Collection;
  /** One of the deal's invoices keeps the business's own currency: shadow mode converted it (0084). */
  keepsOriginalCurrency: boolean;
}

const IDS_PER_READ = 100;
const PAGE = 1000;

type Read = (ids: string[], from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>;

/** Every row of a read of ids: a hundred ids at a time, a page of rows at a time, so none is cut off. */
async function byIds<T>(ids: readonly string[], read: Read): Promise<T[]> {
  const rows: T[] = [];
  for (let at = 0; at < ids.length; at += IDS_PER_READ) {
    const batch = ids.slice(at, at + IDS_PER_READ);
    for (let from = 0; ; from += PAGE) {
      const page = await read(batch, from, from + PAGE - 1);
      if (page.error) throw new Error(page.error.message ?? "the deals' collections were not read");
      const data = (page.data ?? []) as T[];
      rows.push(...data);
      if (data.length < PAGE) break;
    }
  }
  return rows;
}

/** What each of these deals collected, by deal id. */
export async function readDealCollections(deals: readonly DealRecord[], today: string, orgDb: OrgDb = db()): Promise<Map<string, DealCollected>> {
  const collected = new Map<string, DealCollected>();
  if (deals.length === 0) return collected;
  const receivables = await byIds<ReceivableRow>(
    deals.map((deal) => deal.facts.id),
    (batch, from, to) =>
      orgDb
        .from("invoices")
        .select("id, deal_id, amount, currency, status, due_date, original_currency, original_amount")
        .in("deal_id", batch)
        .eq("direction", "receivable")
        .order("id", { ascending: true })
        .range(from, to)
  );
  const receivableIds = receivables.map((row) => row.id);
  const [allocations, wholeMatches] = await Promise.all([
    byIds<AllocationDbRow>(receivableIds, (batch, from, to) =>
      orgDb.from("receivable_allocations").select("id, kind, invoice_id, transfer_id, amount, reverses").in("invoice_id", batch).order("id", { ascending: true }).range(from, to)
    ),
    byIds<TransferRow>(receivableIds, (batch, from, to) =>
      orgDb.from("incoming_transfers").select("id, invoice_id, amount, received_at, tx_hash, chain").in("invoice_id", batch).order("id", { ascending: true }).range(from, to)
    ),
  ]);
  const transferIds = [...new Set(allocations.flatMap((row) => (row.transfer_id ? [row.transfer_id] : [])))];
  const transfers = new Map(
    (
      await byIds<TransferRow>(transferIds, (batch, from, to) =>
        orgDb.from("incoming_transfers").select("id, invoice_id, amount, received_at, tx_hash, chain").in("id", batch).order("id", { ascending: true }).range(from, to)
      )
    ).map((row) => [row.id, row])
  );
  const rows = { receivables, allocations, transfers, wholeMatches };
  for (const deal of deals) {
    collected.set(deal.facts.id, {
      collection: collectionOfRows(deal, rows, today),
      keepsOriginalCurrency: receivables.some((row) => row.deal_id === deal.facts.id && row.original_currency !== null),
    });
  }
  return collected;
}
