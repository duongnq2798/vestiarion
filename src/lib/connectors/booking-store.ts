import { db } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { currentOrgId } from "../context";
import { networkOf, type Network } from "../network";
import { readShadowMode } from "../shadow-mode";
import type { BookingStore, Candidate, NewPosting, PostingPatch, PostingRow } from "./booking-run";
import { isNotSetUp, NotSetUpError, type Connection, type PaymentAccount } from "./connections";
import type { PostingState } from "./posting";
import type { ProviderId, SourceStatus } from "./provider";

/**
 * The bookings' database (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W2, W3, W6), in the
 * workspace's own scope through the DAL: the payables paid on Arc from a connection's bills, `accounting_postings`
 * (migration 0106) with each transition a compare-and-set on its state, and the signed entries, best effort. Before
 * migration 0106 has run, a read says booking is not set up rather than failing.
 */

export const POSTING_COLUMNS =
  "id, connection_id, provider, external_org_id, invoice_id, bill_external_id, amount, currency, paid_on, reference, network, shadow, paid_amount, paid_token, network_fee, organisation_demo, state, reason, message, account, fingerprint, attempts, external_payment_id, sending_until, approved_by, approved_at, sent_at, confirmed_at, created_at";

export interface PostingDbRow {
  id: string;
  connection_id: string;
  provider: ProviderId;
  external_org_id: string;
  invoice_id: string;
  bill_external_id: string;
  amount: number | string;
  currency: string;
  paid_on: string;
  reference: string;
  network: Network;
  shadow: boolean;
  paid_amount: number | string;
  paid_token: "USDC" | "EURC";
  network_fee: number | string | null;
  organisation_demo: boolean | null;
  state: PostingState;
  reason: string | null;
  message: string | null;
  account: unknown;
  fingerprint: string | null;
  attempts: number;
  external_payment_id: string | null;
  sending_until: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  confirmed_at: string | null;
  created_at: string;
}

function accountOf(value: unknown): PaymentAccount | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, code, name, currency } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return { id, code: typeof code === "string" ? code : null, name, currency: typeof currency === "string" ? currency : null };
}

const decimal = (value: number | string) => String(Number(value));

export function toPosting(row: PostingDbRow): PostingRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    externalOrgId: row.external_org_id,
    invoiceId: row.invoice_id,
    billExternalId: row.bill_external_id,
    amount: decimal(row.amount),
    currency: row.currency,
    paidOn: String(row.paid_on).slice(0, 10),
    reference: row.reference,
    network: row.network,
    shadow: row.shadow,
    paidAmount: decimal(row.paid_amount),
    paidToken: row.paid_token,
    networkFee: row.network_fee === null ? null : decimal(row.network_fee),
    organisationDemo: row.organisation_demo,
    state: row.state,
    reason: row.reason,
    message: row.message,
    account: accountOf(row.account),
    fingerprint: row.fingerprint,
    attempts: Number(row.attempts ?? 0),
    externalPaymentId: row.external_payment_id,
    sendingUntil: row.sending_until,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  };
}

function raise(error: { code?: string | null; message: string }): never {
  if (isNotSetUp(error)) throw new NotSetUpError();
  throw new Error(error.message);
}

/** `.in()` filters at most this many ids, so a request's address stays short. */
const CHUNK = 100;

async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => PromiseLike<{ data: unknown; error: { code?: string | null; message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += CHUNK) {
    const result = await read(ids.slice(start, start + CHUNK));
    if (result.error) raise(result.error);
    rows.push(...((result.data ?? []) as T[]));
  }
  return rows;
}

/** The most bills of a connection one run looks at for payments to book: the most recently linked. */
const LINKS_READ = 500;

function patchColumns(patch: Partial<PostingPatch>): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (patch.reason !== undefined) columns.reason = patch.reason;
  if (patch.message !== undefined) columns.message = patch.message === null ? null : patch.message.slice(0, 300);
  if (patch.account !== undefined) columns.account = patch.account;
  if (patch.fingerprint !== undefined) columns.fingerprint = patch.fingerprint;
  if (patch.approvedBy !== undefined) columns.approved_by = patch.approvedBy;
  if (patch.approvedAt !== undefined) columns.approved_at = patch.approvedAt;
  if (patch.sendingUntil !== undefined) columns.sending_until = patch.sendingUntil;
  if (patch.attempts !== undefined) columns.attempts = patch.attempts;
  if (patch.externalPaymentId !== undefined) columns.external_payment_id = patch.externalPaymentId;
  if (patch.sentAt !== undefined) columns.sent_at = patch.sentAt;
  if (patch.confirmedAt !== undefined) columns.confirmed_at = patch.confirmedAt;
  if (patch.organisationDemo !== undefined) columns.organisation_demo = patch.organisationDemo;
  return columns;
}

export const bookingStore: BookingStore = {
  async candidates(connection: Connection): Promise<Candidate[]> {
    const links = await db()
      .from("external_links")
      .select("external_id, local_id")
      .eq("connection_id", connection.id)
      .eq("object_type", "bill")
      .not("local_id", "is", null)
      .order("linked_at", { ascending: false })
      .limit(LINKS_READ);
    if (links.error) raise(links.error);
    const billOf = new Map(((links.data ?? []) as Array<{ external_id: string; local_id: string }>).map((row) => [row.local_id, row.external_id]));
    if (billOf.size === 0) return [];
    const booked = new Set(
      (
        await inChunks<{ invoice_id: string }>([...billOf.keys()], (chunk) =>
          db().from("accounting_postings").select("invoice_id").eq("provider", connection.provider).in("invoice_id", chunk)
        )
      ).map((row) => row.invoice_id)
    );
    const open = [...billOf.keys()].filter((id) => !booked.has(id));
    if (open.length === 0) return [];
    const invoices = await inChunks<{
      id: string;
      amount: number | string;
      currency: string | null;
      paid_amount: number | string | null;
      original_currency: string | null;
      original_amount: number | string | null;
      tx_ref: string | null;
      settled_at: string | null;
    }>(open, (chunk) =>
      db()
        .from("invoices")
        .select("id, amount, currency, paid_amount, original_currency, original_amount, tx_ref, settled_at")
        .in("id", chunk)
        .eq("direction", "payable")
        .eq("status", "paid")
    );
    if (invoices.length === 0) return [];
    const intents = await inChunks<{
      source_id: string;
      provider: string | null;
      provider_mode: string | null;
      tx_hash: string | null;
      confirmed_at: string | null;
      fee_usd: number | string | null;
      bridge_fee: number | string | null;
      network: string | null;
    }>(
      invoices.map((invoice) => invoice.id),
      (chunk) =>
        db()
          .from("payment_intents")
          .select("source_id, provider, provider_mode, tx_hash, confirmed_at, fee_usd, bridge_fee, network")
          .eq("source_type", "invoice")
          .eq("status", "confirmed")
          .in("source_id", chunk)
    );
    const intentOf = new Map(intents.map((intent) => [intent.source_id, intent]));
    const billIds = [...new Set(invoices.map((invoice) => billOf.get(invoice.id) as string))];
    const bills = await inChunks<{ external_id: string; currency: string; source_status: SourceStatus; amount_due: number | string; number: string | null; contact_name: string }>(
      billIds,
      (chunk) => db().from("accounting_bills").select("external_id, currency, source_status, amount_due, number, contact_name").eq("connection_id", connection.id).in("external_id", chunk)
    );
    const billRow = new Map(bills.map((bill) => [bill.external_id, bill]));
    return invoices.flatMap((invoice): Candidate[] => {
      const intent = intentOf.get(invoice.id);
      // A payment made on Arc, live: a sandbox's simulated payment has no transaction to book.
      if (!intent || (intent.provider_mode ?? intent.provider) === "simulate") return [];
      let network: Network;
      try {
        network = networkOf(intent.network);
      } catch {
        return [];
      }
      const billExternalId = billOf.get(invoice.id) as string;
      const bill = billRow.get(billExternalId);
      return [
        {
          invoiceId: invoice.id,
          billExternalId,
          network,
          invoice: {
            amount: Number(invoice.amount),
            currency: invoice.currency ?? "USDC",
            paidAmount: invoice.paid_amount === null ? null : Number(invoice.paid_amount),
            originalCurrency: invoice.original_currency,
            originalAmount: invoice.original_amount === null ? null : Number(invoice.original_amount),
            txRef: invoice.tx_ref,
            settledAt: invoice.settled_at,
          },
          intent: {
            txHash: intent.tx_hash,
            confirmedAt: intent.confirmed_at,
            feeUsd: intent.fee_usd === null ? null : Number(intent.fee_usd),
            bridgeFee: intent.bridge_fee === null ? null : Number(intent.bridge_fee),
          },
          bill: bill
            ? { currency: bill.currency, sourceStatus: bill.source_status, amountDue: decimal(bill.amount_due), number: bill.number, contactName: bill.contact_name }
            : null,
        },
      ];
    });
  },

  async shadowOn(): Promise<boolean> {
    return (await readShadowMode(db())) !== null;
  },

  async insert(connection: Connection, posting: NewPosting): Promise<PostingRow | null> {
    const result = await db()
      .from("accounting_postings")
      .insert({
        connection_id: connection.id,
        provider: connection.provider,
        external_org_id: connection.externalOrgId,
        invoice_id: posting.invoiceId,
        bill_external_id: posting.billExternalId,
        amount: posting.facts.amount,
        currency: posting.facts.currency,
        paid_on: posting.facts.paidOn,
        reference: posting.facts.reference,
        network: posting.network,
        shadow: posting.shadow,
        paid_amount: posting.facts.paidAmount,
        paid_token: posting.facts.paidToken,
        network_fee: posting.facts.networkFee,
        organisation_demo: posting.organisationDemo,
        state: posting.state,
        reason: posting.reason,
        message: posting.message,
      })
      .select(POSTING_COLUMNS);
    // Drafted already, by another run a moment ago: one booking per payable and provider.
    if (result.error?.code === "23505") return null;
    if (result.error) raise(result.error);
    const row = ((result.data ?? []) as unknown as PostingDbRow[])[0];
    return row ? toPosting(row) : null;
  },

  async move(posting, from, to, patch, options): Promise<PostingRow | null> {
    let query = db()
      .from("accounting_postings")
      .update({ state: to, ...patchColumns(patch) })
      .eq("id", posting.id);
    const others = from.filter((state) => state !== "sending");
    if (from.includes("sending") && options?.leaseOverAt) {
      // A claim takes a booking being sent only once that send's lease ran out.
      const lease = `and(state.eq.sending,or(sending_until.is.null,sending_until.lte.${options.leaseOverAt}))`;
      query = query.or(others.length > 0 ? `state.in.(${others.join(",")}),${lease}` : lease);
    } else {
      query = query.in("state", [...from]);
    }
    if (patch.attempts !== undefined) query = query.eq("attempts", posting.attempts);
    const result = await query.select(POSTING_COLUMNS);
    if (result.error) raise(result.error);
    const row = ((result.data ?? []) as unknown as PostingDbRow[])[0];
    return row ? toPosting(row) : null;
  },

  async drafts(connectionId: string) {
    const result = await db().from("accounting_postings").select(POSTING_COLUMNS).eq("connection_id", connectionId).eq("state", "draft").order("created_at", { ascending: true }).limit(200);
    if (result.error) raise(result.error);
    const rows = ((result.data ?? []) as unknown as PostingDbRow[]).map(toPosting);
    if (rows.length === 0) return [];
    const bills = await billsByExternalId(connectionId, rows.map((row) => row.billExternalId));
    return rows.map((posting) => {
      const bill = bills.get(posting.billExternalId);
      return { posting, bill: bill ? { status: bill.status, amountDue: bill.amountDue } : null };
    });
  },

  async inFlight(connectionId: string, nowIso: string): Promise<PostingRow[]> {
    const result = await db()
      .from("accounting_postings")
      .select(POSTING_COLUMNS)
      .eq("connection_id", connectionId)
      .or(`state.eq.sent,and(state.eq.sending,or(sending_until.is.null,sending_until.lte.${nowIso}))`)
      .order("created_at", { ascending: true })
      .limit(50);
    if (result.error) raise(result.error);
    return ((result.data ?? []) as unknown as PostingDbRow[]).map(toPosting);
  },

  async record(entry) {
    await appendLedgerEntryBestEffort(currentOrgId(), entry);
  },
};

/** One booking of the workspace in scope, by its id; null when it has none. */
export async function postingById(id: string): Promise<PostingRow | null> {
  const result = await db().from("accounting_postings").select(POSTING_COLUMNS).eq("id", id).limit(1);
  if (result.error) raise(result.error);
  const row = ((result.data ?? []) as unknown as PostingDbRow[])[0];
  return row ? toPosting(row) : null;
}

/** The connection's bookings that are still to do or recently done, newest first. */
export async function postingsOf(connectionId: string, limit = 60): Promise<PostingRow[]> {
  const result = await db().from("accounting_postings").select(POSTING_COLUMNS).eq("connection_id", connectionId).order("created_at", { ascending: false }).limit(limit);
  if (result.error) raise(result.error);
  return ((result.data ?? []) as unknown as PostingDbRow[]).map(toPosting);
}

/** The bills of a connection as the last sync left them, by their ids in the provider. */
export async function billsByExternalId(
  connectionId: string,
  externalIds: readonly string[]
): Promise<Map<string, { amountDue: string; status: SourceStatus; currency: string; number: string | null; contactName: string }>> {
  const rows = await inChunks<{ external_id: string; amount_due: number | string; source_status: SourceStatus; currency: string; number: string | null; contact_name: string }>(
    [...new Set(externalIds)],
    (chunk) => db().from("accounting_bills").select("external_id, amount_due, source_status, currency, number, contact_name").eq("connection_id", connectionId).in("external_id", chunk)
  );
  return new Map(rows.map((row) => [row.external_id, { amountDue: decimal(row.amount_due), status: row.source_status, currency: row.currency, number: row.number, contactName: row.contact_name }]));
}

