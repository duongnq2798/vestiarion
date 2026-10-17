import { ALLOCATION_COLUMNS, readAllocationRows, toAllocationRow, type AllocationDbRow } from "../allocations/book";
import { allocationErrorFromDb, fromMicros, receivableBalance, toMicros } from "../allocations/model";
import type { ChainProvider, InboundTransfer, Stablecoin } from "../circle/types";
import { sameAddress } from "../counterparty-address";
import { currentOrgId } from "../context";
import { platformDb, unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { floatAddress } from "../test-usdc";

/**
 * Money in, matched to what was owed (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2).
 *
 * Each completed inbound USDC or EURC transfer Circle reports for the operating wallet is recorded once
 * (R3). An unmatched one is then matched to an open receivable of the same currency and amount: the
 * client's own address first (oldest due among them), else the only receivable of that amount. Two of
 * the same amount with no sender to tell them apart stay unmatched for a person (R1). A sandbox has no
 * real wallet and reads nothing (R4). Only a transfer matched or applied counts as money received: the wallet also
 * receives faucet drips and swap proceeds, which owe nothing to a receivable, nor does test USDC from Vestiarion's
 * float (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T6), which is never matched.
 *
 * Payments a person applies (docs/superpowers/specs/2026-10-12-allocations-design.md L3) stay theirs: a transfer with an
 * allocation row, and a receivable with one, are left out of the whole match, as migration 0103 refuses either way. A
 * transfer that is exactly what is still owed on a part-paid receivable is applied to it by the same two rules a whole
 * match trusts, as an allocation row the agent writes and signs (ar_payment_applied). Before 0103 runs there are no
 * such rows, and the match is as it was.
 *
 * A receivable whose customer accepted the agent's discount offer (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C6) is also matched by the offer's discounted amount, for money that arrived after the offer was made and by the end of
 * its pay-by day (UTC); it settles the receivable as any whole match does, and the discount is signed
 * (customer_discount_taken). Only an accepted offer lowers what pays a receivable: a discount typed on one, from a form,
 * an import or the API, never does. Money of the discounted amount that arrives earlier or later matches nothing and is
 * left for a person. Before migration 0129 runs there are no offers, and the match is as it was.
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
  /** The discount offer its customer accepted (C5); null or absent when none. */
  discount?: AcceptedDiscount | null;
}

/** An accepted discount offer, as the matcher reads it: what pays the receivable, from when, through which UTC day. */
export interface AcceptedDiscount {
  offerId: string;
  pct: number;
  /** The offer's discounted amount, as the database worked it out and the customer was told it. */
  amount: number;
  /** When the offer was made: money that arrived before it was not paid at its discount. */
  since: string;
  /** Its pay-by day, "YYYY-MM-DD", the last UTC day the discounted amount pays it. */
  payBy: string;
}

/** What pays a receivable for money that arrived at a time: the accepted offer's discounted amount within its days, else its amount. */
export function owedAt(receivable: OpenReceivable, arrived: Date): { amount: number; atDiscount: boolean } {
  const discount = receivable.discount;
  if (discount) {
    const at = arrived.getTime();
    const end = Date.parse(`${discount.payBy}T00:00:00Z`) + DAY_MS;
    if (at >= Date.parse(discount.since) && at < end) return { amount: discount.amount, atDiscount: true };
  }
  return { amount: receivable.amount, atDiscount: false };
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
export function matchTransfer(
  transfer: InboundTransfer,
  open: OpenReceivable[]
): { invoiceId: string; matchedBy: "sender" | "amount"; atDiscount?: true } | null {
  const arrived = Date.parse(transfer.receivedAt);
  const same = (a: number) => Math.abs(a - transfer.amount) < SAME_AMOUNT;
  // Paid at the discount the customer accepted (C6), while it applies; the full amount always pays it too.
  const atDiscount = new Set(
    open.filter((receivable) => {
      const owed = owedAt(receivable, new Date(arrived));
      return owed.atDiscount && same(owed.amount);
    }).map((receivable) => receivable.id)
  );
  const candidates = open.filter(
    (receivable) =>
      receivable.currency === transfer.token && (same(receivable.amount) || atDiscount.has(receivable.id)) && arrived >= Date.parse(receivable.createdAt)
  );
  if (candidates.length === 0) return null;
  // At a discount: said only when it is, so a match at the full amount reads exactly as before.
  const found = (receivable: OpenReceivable, matchedBy: "sender" | "amount") =>
    atDiscount.has(receivable.id) ? { invoiceId: receivable.id, matchedBy, atDiscount: true as const } : { invoiceId: receivable.id, matchedBy };
  const bySender = transfer.from
    ? candidates.filter((receivable) => receivable.clientAddress && sameAddress(receivable.clientAddress, transfer.from as string))
    : [];
  if (bySender.length > 0) {
    const oldest = [...bySender].sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate))[0];
    return found(oldest, "sender");
  }
  const linked = candidates.filter((receivable) => receivable.hasPayLink);
  return candidates.length === 1 && linked.length === 1 ? found(linked[0], "amount") : null;
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

  // Test USDC from Vestiarion's float is money in, owed by no client (test USDC T6): never matched, whatever its amount.
  // The addresses its entries name, and the float's own, for a transfer whose entry is not written yet (review fix E);
  // `floatAddress` asks Circle nothing when the float is not set up, and gives null rather than stop this stage.
  const [grants, float] = await Promise.all([orgDb.from("ledger_entries").select("detail").eq("action", "test_usdc_added"), floatAddress()]);
  const fromFloat = new Set(
    (unwrap(grants) as Array<{ detail: { from?: unknown } | null }>)
      .map((entry) => (typeof entry.detail?.from === "string" ? entry.detail.from.toLowerCase() : null))
      .filter((address): address is string => address !== null)
  );
  if (float) fromFloat.add(float.toLowerCase());

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
  // The discount offers customers accepted (0129): read best effort, so before it runs, or on any error, none applies.
  const accepted = new Map<string, AcceptedDiscount>();
  if (openRows.length > 0) {
    const offers = await orgDb
      .from("customer_discount_offers")
      .select("id, invoice_id, discount_pct, offered_amount, pay_by, created_at")
      .eq("status", "accepted")
      .in("invoice_id", openRows.map((row) => row.id));
    if (!offers.error) {
      for (const row of (offers.data ?? []) as Array<{ id: string; invoice_id: string; discount_pct: string; offered_amount: string; pay_by: string; created_at: string }>) {
        accepted.set(row.invoice_id, { offerId: row.id, pct: Number(row.discount_pct), amount: Number(row.offered_amount), since: row.created_at, payBy: String(row.pay_by).slice(0, 10) });
      }
    }
  }
  // What a person applied (0103): null before it runs, so nothing is.
  const allocations = (await readAllocationRows(orgDb, { invoiceIds: openRows.map((row) => row.id), transferIds: unmatched.map((row) => row.id) })) ?? [];
  const appliedTransfers = new Set(allocations.flatMap((row) => (row.transferId ? [row.transferId] : [])));
  const appliedInvoices = new Set(allocations.map((row) => row.invoiceId));
  const asOpen = (row: (typeof openRows)[number]): OpenReceivable => ({
    id: row.id,
    counterpartyId: row.counterparty_id,
    clientName: row.counterparties.name,
    amount: Number(row.amount),
    currency: (row.currency ?? "USDC") as Stablecoin,
    dueDate: row.due_date,
    clientAddress: row.counterparties.address,
    createdAt: row.created_at,
    hasPayLink: linked.has(row.id),
    discount: accepted.get(row.id) ?? null,
  });
  let open: OpenReceivable[] = openRows.filter((row) => !appliedInvoices.has(row.id)).map(asOpen);
  // A part-paid receivable is matched by what is still owed on it, never by its full amount.
  let partPaid: OpenReceivable[] = openRows
    .filter((row) => appliedInvoices.has(row.id))
    .map((row) => {
      const receivable = asOpen(row);
      const { outstanding } = receivableBalance(
        {
          id: row.id,
          counterpartyId: row.counterparty_id,
          customer: receivable.clientName,
          amount: toMicros(row.amount),
          currency: receivable.currency,
          status: "pending",
          dueDate: row.due_date,
          createdAt: row.created_at,
          memo: null,
          poReference: null,
        },
        allocations,
        false
      );
      // What is still owed, never at a discount: a discount is only offered on a receivable nothing was applied to (C2).
      return { ...receivable, amount: fromMicros(outstanding), discount: null };
    })
    .filter((receivable) => receivable.amount > 0);

  const lines: ReceiptsResult["lines"] = [];
  let matched = 0;
  for (const row of unmatched) {
    if (row.from_address && fromFloat.has(row.from_address.toLowerCase())) continue;
    // A payment a person applied is theirs to finish.
    if (appliedTransfers.has(row.id)) continue;
    const transfer: InboundTransfer = {
      circleTxId: row.circle_tx_id,
      txHash: row.tx_hash,
      from: row.from_address,
      amount: Number(row.amount),
      token: row.token,
      chain: provider.network.circleBlockchain,
      receivedAt: row.received_at,
    };
    // One pool: a part-paid receivable is asked for what is still owed, so an open one of that same amount makes an
    // amount alone ambiguous, and the client's own address decides either way (R1).
    const match = matchTransfer(transfer, [...open, ...partPaid]);
    if (!match) continue;
    const rest = partPaid.find((candidate) => candidate.id === match.invoiceId);
    if (rest) {
      if (await applyRest(orgDb, provider, row.id, transfer, rest, match.matchedBy)) {
        partPaid = partPaid.filter((candidate) => candidate.id !== rest.id);
        matched += 1;
        lines.push({ domain: "ar", message: `Received ${transfer.amount} ${transfer.token} from ${rest.clientName} on ${provider.network.label}, what was still owed (matched by ${match.matchedBy})` });
      }
      continue;
    }
    const receivable = open.find((candidate) => candidate.id === match.invoiceId) as OpenReceivable;

    // Claim the transfer first, then settle the receivable; each a compare-and-set, so a check and a
    // cycle running together settle it once (R3). Migration 0103 refuses the claim when a person applied the transfer,
    // or a payment to the receivable, a moment before: that is left to them.
    const claim = await orgDb.from("incoming_transfers").update({ invoice_id: receivable.id, matched_by: match.matchedBy }).eq("id", row.id).is("invoice_id", null).select("id");
    if (claim.error && /^(transfer_partly_applied|receivable_partly_paid):/.test(claim.error.message ?? "")) continue;
    const claimed = unwrap(claim) as Array<{ id: string }>;
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
      summary: `Received ${transfer.amount} ${transfer.token} from ${receivable.clientName} on ${provider.network.label}`,
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
        ...(match.atDiscount ? { atDiscount: true } : {}),
      },
    });
    if (match.atDiscount && receivable.discount) await discountTaken(receivable, transfer);
    open = open.filter((candidate) => candidate.id !== receivable.id);
    matched += 1;
    lines.push({ domain: "ar", message: `Received ${transfer.amount} ${transfer.token} from ${receivable.clientName} on ${provider.network.label} (matched by ${match.matchedBy})` });
  }
  return { recorded: transfers.length, matched, lines };
}

/**
 * A receivable paid at the discount its customer accepted (C6): the offer marked paid, and what the discount cost signed
 * as customer_discount_taken. Best effort after the settlement it follows: a failure is logged, never undoes it.
 */
async function discountTaken(receivable: OpenReceivable, transfer: InboundTransfer): Promise<void> {
  const discount = receivable.discount as AcceptedDiscount;
  const cost = Number((receivable.amount - transfer.amount).toFixed(6));
  try {
    const orgId = currentOrgId();
    const settled = await platformDb().rpc("settle_customer_discount", { p_org_id: orgId, p_invoice_id: receivable.id });
    if (settled.error) console.error("customer discount not marked paid", settled.error.message);
    await appendLedgerEntry({
      actor: "agent",
      domain: "ar",
      action: "customer_discount_taken",
      summary: `${receivable.clientName} paid ${transfer.amount} ${transfer.token} by ${discount.payBy}, ${discount.pct.toFixed(2)}% off ${receivable.amount}: the discount cost ${cost} ${transfer.token}`,
      detail: {
        invoiceId: receivable.id,
        counterpartyId: receivable.counterpartyId,
        offerId: discount.offerId,
        amount: receivable.amount,
        received: transfer.amount,
        discountPct: discount.pct,
        discount: cost,
        payBy: discount.payBy,
        currency: transfer.token,
        txHash: transfer.txHash,
      },
    });
  } catch (error) {
    console.error("customer discount not recorded", error instanceof Error ? error.message : "unknown error");
  }
}

/**
 * The rest of a part-paid receivable, applied by the agent (allocations L3): one payment row of the whole transfer, which
 * the trigger of 0103 checks and which settles the receivable, then its signed ar_payment_applied. A refusal of the
 * database (a person applied it a moment before) leaves it to them.
 */
async function applyRest(
  orgDb: OrgDb,
  provider: ChainProvider,
  transferId: string,
  transfer: InboundTransfer,
  receivable: OpenReceivable,
  matchedBy: "sender" | "amount"
): Promise<boolean> {
  const write = await orgDb
    .from("receivable_allocations")
    .insert({ kind: "payment", invoice_id: receivable.id, transfer_id: transferId, amount: transfer.amount, currency: transfer.token, basis: matchedBy, created_by: null })
    .select(ALLOCATION_COLUMNS)
    .single<AllocationDbRow>();
  if (write.error) {
    if (allocationErrorFromDb(write.error)) return false;
    throw new Error(write.error.message);
  }
  const row = toAllocationRow(write.data);
  await appendLedgerEntry({
    actor: "agent",
    domain: "ar",
    action: "ar_payment_applied",
    summary: `Received ${transfer.amount} ${transfer.token} from ${receivable.clientName} on ${provider.network.label}, what was still owed, and applied it`,
    detail: {
      by: null,
      allocationId: row.id,
      invoiceId: receivable.id,
      counterpartyId: receivable.counterpartyId,
      transferId,
      amount: transfer.amount,
      currency: transfer.token,
      txHash: transfer.txHash,
      from: transfer.from,
      basis: matchedBy,
      outstandingAfter: 0,
      unappliedAfter: 0,
      group: row.id,
      receivedAt: transfer.receivedAt,
    },
  });
  return true;
}
