import type { ChainProvider, InboundTransfer, Stablecoin } from "../circle/types";
import { sameAddress } from "../counterparty-address";
import { unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";

/**
 * Money in, matched to what was owed (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2).
 *
 * Each completed inbound USDC or EURC transfer Circle reports for the operating wallet is recorded once
 * (R3). An unmatched one is then matched to an open receivable of the same currency and amount: the
 * client's own address first (oldest due among them), else the only receivable of that amount. Two of
 * the same amount with no sender to tell them apart stay unmatched for a person (R1). A sandbox has no
 * real wallet and reads nothing (R4). Only a matched transfer counts as money received: the wallet also
 * receives faucet drips and swap proceeds, which owe nothing to a receivable.
 */

export interface OpenReceivable {
  id: string;
  counterpartyId: string;
  clientName: string;
  amount: number;
  currency: Stablecoin;
  dueDate: string;
  clientAddress: string | null;
  /** When the receivable was added: money that arrived before it cannot be paying it. */
  createdAt: string;
  /** Whether its client was sent a live pay link, the only case a match by amount alone is trusted. */
  hasPayLink: boolean;
}

export interface ReceiptsResult {
  /** Transfers Circle reported in this read (each recorded once, R3). */
  recorded: number;
  /** Receivables settled by a transfer in this run. */
  matched: number;
  lines: Array<{ domain: string; message: string }>;
}

/** Amounts are stored to 6 places: half a base unit is "the same amount". */
const SAME_AMOUNT = 0.0000005;
const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 30;

/**
 * The receivable a transfer settles, if one can be told for sure (R1). Only money that arrived after the
 * receivable was added can be paying it: the operating wallet also receives faucet drips of round
 * amounts, which a receivable of the same figure must not swallow. The client's own address on file is
 * trusted outright; an amount alone only for a receivable whose client was sent its pay link, and only
 * when it is the one such receivable.
 */
export function matchTransfer(transfer: InboundTransfer, open: OpenReceivable[]): { invoiceId: string; matchedBy: "sender" | "amount" } | null {
  const arrived = Date.parse(transfer.receivedAt);
  const candidates = open.filter(
    (receivable) =>
      receivable.currency === transfer.token && Math.abs(receivable.amount - transfer.amount) < SAME_AMOUNT && arrived >= Date.parse(receivable.createdAt)
  );
  if (candidates.length === 0) return null;
  const bySender = transfer.from
    ? candidates.filter((receivable) => receivable.clientAddress && sameAddress(receivable.clientAddress, transfer.from as string))
    : [];
  if (bySender.length > 0) {
    const oldest = [...bySender].sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate))[0];
    return { invoiceId: oldest.id, matchedBy: "sender" };
  }
  const linked = candidates.filter((receivable) => receivable.hasPayLink);
  return candidates.length === 1 && linked.length === 1 ? { invoiceId: linked[0].id, matchedBy: "amount" } : null;
}

export async function recordIncomingTransfers(
  orgDb: OrgDb,
  provider: ChainProvider,
  operatingAccountId: string,
  now: number = Date.now()
): Promise<ReceiptsResult> {
  const none: ReceiptsResult = { recorded: 0, matched: 0, lines: [] };
  if (provider.mode !== "live" || !provider.listInboundTransfers) return none;

  // From a day before the latest transfer already recorded (Circle filters by creation; the unique key
  // drops what overlaps), or the last 30 days for a wallet read for the first time.
  const latest = unwrap(
    await orgDb.from("incoming_transfers").select("received_at").order("received_at", { ascending: false }).limit(1)
  ) as Array<{ received_at: string }>;
  const since = new Date(latest[0] ? Date.parse(latest[0].received_at) - DAY_MS : now - LOOKBACK_DAYS * DAY_MS).toISOString();

  const transfers = await provider.listInboundTransfers(operatingAccountId, since);
  if (transfers.length > 0) {
    // A write that asks nothing back: PostgREST answers with no data, so only its error is read.
    const recorded = await orgDb.from("incoming_transfers").upsert(
        transfers.map((transfer) => ({
          circle_tx_id: transfer.circleTxId,
          tx_hash: transfer.txHash,
          from_address: transfer.from,
          amount: transfer.amount,
          token: transfer.token,
          chain: transfer.chain,
          received_at: transfer.receivedAt,
        })),
        { onConflict: "org_id,circle_tx_id", ignoreDuplicates: true }
      );
    if (recorded.error) throw new Error(recorded.error.message);
  }

  // Every unmatched transfer is tried, not only this read's: a receivable added after its money arrived still finds it.
  const unmatched = unwrap(
    await orgDb
      .from("incoming_transfers")
      .select("id, circle_tx_id, tx_hash, from_address, amount, token, received_at")
      .is("invoice_id", null)
      .gte("received_at", new Date(now - LOOKBACK_DAYS * DAY_MS).toISOString())
      .order("received_at", { ascending: true })
      .limit(50)
  ) as Array<{ id: string; circle_tx_id: string; tx_hash: string | null; from_address: string | null; amount: string; token: Stablecoin; received_at: string }>;
  if (unmatched.length === 0) return { ...none, recorded: transfers.length };

  const openRows = unwrap(
    await orgDb
      .from("invoices")
      .select("id, counterparty_id, amount, currency, due_date, created_at, counterparties(name, address)")
      .eq("direction", "receivable")
      .in("status", ["pending", "matched"])
  ) as unknown as Array<{
    id: string;
    counterparty_id: string;
    amount: string;
    currency: string | null;
    due_date: string;
    created_at: string;
    counterparties: { name: string; address: string | null };
  }>;
  const linked = new Set(
    openRows.length === 0
      ? []
      : (unwrap(
          await orgDb.from("receivable_links").select("invoice_id").is("revoked_at", null).in("invoice_id", openRows.map((row) => row.id))
        ) as Array<{ invoice_id: string }>).map((link) => link.invoice_id)
  );
  let open: OpenReceivable[] = openRows.map((row) => ({
    id: row.id,
    counterpartyId: row.counterparty_id,
    clientName: row.counterparties.name,
    amount: Number(row.amount),
    currency: (row.currency ?? "USDC") as Stablecoin,
    dueDate: row.due_date,
    clientAddress: row.counterparties.address,
    createdAt: row.created_at,
    hasPayLink: linked.has(row.id),
  }));

  const lines: ReceiptsResult["lines"] = [];
  let matched = 0;
  for (const row of unmatched) {
    const transfer: InboundTransfer = {
      circleTxId: row.circle_tx_id,
      txHash: row.tx_hash,
      from: row.from_address,
      amount: Number(row.amount),
      token: row.token,
      chain: "ARC-TESTNET",
      receivedAt: row.received_at,
    };
    const match = matchTransfer(transfer, open);
    if (!match) continue;
    const receivable = open.find((candidate) => candidate.id === match.invoiceId) as OpenReceivable;

    // Claim the transfer first, then settle the receivable; each a compare-and-set, so a check and a
    // cycle running together settle it once (R3).
    const claimed = unwrap(
      await orgDb.from("incoming_transfers").update({ invoice_id: receivable.id, matched_by: match.matchedBy }).eq("id", row.id).is("invoice_id", null).select("id")
    ) as Array<{ id: string }>;
    if (claimed.length === 0) continue;
    const settled = unwrap(
      await orgDb
        .from("invoices")
        .update({ status: "received", settled_at: row.received_at, tx_ref: row.tx_hash, decided_at: new Date(now).toISOString() })
        .eq("id", receivable.id)
        .in("status", ["pending", "matched"])
        .select("id")
    ) as Array<{ id: string }>;
    if (settled.length === 0) {
      const released = await orgDb.from("incoming_transfers").update({ invoice_id: null, matched_by: null }).eq("id", row.id);
      if (released.error) throw new Error(released.error.message);
      continue;
    }

    await appendLedgerEntry({
      actor: "agent",
      domain: "ar",
      action: "ar_received",
      summary: `Received ${transfer.amount} ${transfer.token} from ${receivable.clientName} on Arc testnet`,
      detail: {
        invoiceId: receivable.id,
        counterpartyId: receivable.counterpartyId,
        amount: transfer.amount,
        currency: transfer.token,
        txHash: transfer.txHash,
        from: transfer.from,
        circleTxId: transfer.circleTxId,
        matchedBy: match.matchedBy,
        receivedAt: transfer.receivedAt,
      },
    });
    open = open.filter((candidate) => candidate.id !== receivable.id);
    matched += 1;
    lines.push({ domain: "ar", message: `Received ${transfer.amount} ${transfer.token} from ${receivable.clientName} on Arc testnet (matched by ${match.matchedBy})` });
  }
  return { recorded: transfers.length, matched, lines };
}
