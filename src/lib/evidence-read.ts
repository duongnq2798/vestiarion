import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import {
  buildEvidenceChain,
  chainAnchors,
  givenLinks,
  paymentOnChain,
  type EvidenceChain,
  type EvidenceCounterparty,
  type EvidenceEntry,
  type EvidenceInput,
  type EvidenceInvoice,
  type EvidenceMilestone,
  type EvidencePayment,
  type EvidenceReceipt,
  type EvidenceScreening,
  type EvidenceSubject,
} from "./evidence-chain";
import { checkEvidenceLinks, type LinkCheckOptions } from "./evidence-links/check";
import { ledgerPublicKeyPems, ledgerVerificationKeyring } from "./ledger";
import { listMembers } from "./platform/members";
import { readOnChain } from "./receipts/onchain";
import { verifyEntry, type EntryCheck } from "./receipts/verify";
import { workspaceNetwork } from "./workspace-network";

/**
 * What a payment's evidence page and its download read (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E5),
 * in the workspace in scope: the record and its counterparty, every entry the chain rests on, the screening check at the
 * time of the decision it rests on, the payment, the receipt and the members' emails; then each entry's signature and
 * Arc's record of the transaction. `buildEvidenceChain` decides what they say. Reads only, and only through `db()`.
 */

export type EvidenceKindParam = EvidenceSubject["kind"];

export interface EvidenceRequest {
  kind: EvidenceKindParam;
  id: string;
}

/**
 * Whether the receipt's link opens now, was stopped, or was never made (E10); `unavailable` for a payable with no
 * payment on chain, which has no receipt to share (payment receipts P1); null for a milestone, which has none.
 */
export type ReceiptState = { state: "shared" | "stopped" | "none" | "unavailable" } | null;

export interface EvidenceRead {
  chain: EvidenceChain;
  /** The public halves of the workspace's keys, by id: what the reader's browser checks the entries with. */
  publicKeys: Record<string, string>;
  receipt: ReceiptState;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A kind and an id the page or the download may look up; null for anything else, which is never queried. */
export function evidenceRequest(kind: unknown, id: unknown): EvidenceRequest | null {
  if (kind !== "invoice" && kind !== "milestone") return null;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  return { kind, id: id.toLowerCase() };
}

const INTENT_COLUMNS =
  "status, provider, provider_mode, token, amount, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, confirmed_at, network, provider_tx_id, provider_state, failure_reason, last_error";

/** The counterparty entries the chain words: who gave and confirmed the address, purchase orders, dismissed matches. */
const COMPLIANCE_ACTIONS = [
  "create_counterparty",
  "counterparty_address_changed",
  "counterparty_address_confirmed",
  "counterparty_purchase_orders_changed",
  "screening_match_dismissed",
  // Who created the payee link an address came through (independent review, 2026-10-15).
  "payee_link_created",
];
/** More than any counterparty has: each of these entries is a person's act or an address change. */
const COMPLIANCE_LIMIT = 500;

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);

function invoiceOf(row: Row): EvidenceInvoice {
  return {
    id: String(row.id),
    direction: String(row.direction),
    counterparty_id: String(row.counterparty_id),
    amount: num(row.amount),
    currency: str(row.currency),
    memo: str(row.memo),
    po_reference: str(row.po_reference),
    goods_received: row.goods_received === true,
    due_date: String(row.due_date),
    status: String(row.status),
    tx_ref: str(row.tx_ref),
    paid_amount: row.paid_amount == null ? null : num(row.paid_amount),
  };
}

function milestoneOf(row: Row): EvidenceMilestone {
  const detail = row.verification_detail;
  return {
    id: String(row.id),
    contractor_id: String(row.contractor_id),
    title: String(row.title),
    amount: num(row.amount),
    status: String(row.status),
    verified: row.verified === true,
    verification_method: String(row.verification_method ?? ""),
    verification_status: String(row.verification_status ?? ""),
    verification_source: str(row.verification_source),
    verification_checked_at: str(row.verification_checked_at),
    verified_at: str(row.verified_at),
    verification_detail: detail !== null && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null,
    tx_ref: str(row.tx_ref),
    escrow_state: str(row.escrow_state),
    escrow_payee: str(row.escrow_payee),
    escrow_amount: (row.escrow_amount as number | string | null | undefined) ?? null,
    escrow_release_tx_hash: str(row.escrow_release_tx_hash),
  };
}

function counterpartyOf(row: Row | null): EvidenceCounterparty | null {
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    address: str(row.address),
    chain: str(row.chain),
    risk_level: String(row.risk_level ?? "unscreened"),
    purchase_order_required: row.purchase_order_required !== false,
    sample: row.sample === true,
  };
}

/** A ledger row as the chain reads it: the whole signed body and its chain fields, nothing of the workspace's id. */
function entryOf(row: Row): EvidenceEntry {
  return {
    seq: num(row.seq),
    id: String(row.id),
    ts: String(row.ts),
    actor: String(row.actor),
    domain: String(row.domain),
    action: String(row.action),
    summary: String(row.summary),
    detail: (row.detail as Record<string, unknown>) ?? {},
    body_hash: String(row.body_hash),
    signature: String(row.signature),
    prev_hash: String(row.prev_hash),
    hash: String(row.hash),
    signing_key_id: str(row.signing_key_id),
  };
}

async function maybeOne(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row | null> {
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  const rows = result.data as Row[] | Row | null;
  if (Array.isArray(rows)) return rows[0] ?? null;
  return rows ?? null;
}

async function ledgerRows(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<EvidenceEntry[]> {
  return (unwrap(await query) as Row[]).map(entryOf);
}

/** Members' emails by user id, for the workspace in scope; null when they cannot be read (E5). */
async function memberEmails(): Promise<Map<string, string> | null> {
  try {
    return new Map((await listMembers(currentOrgId())).map((member) => [member.userId, member.email]));
  } catch (error) {
    console.error("evidence: members not read", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The evidence for one payable or milestone of the workspace in scope, or null when it has none: a receivable, an id
 * that is not a UUID, or a record this workspace does not hold. `fetch` and `rpcUrl` reach Arc's record (tests);
 * `links` how the given links are checked (tests).
 *
 * The links a person, a payee or GitHub gave (a pull request, a comment, the evidence a milestone was verified by hand
 * with) are checked before the page says what they are (evidence access E1): on the allow-list only, never by their own
 * address, kept briefly (`./evidence-links/check`).
 */
export async function readEvidence(
  kind: unknown,
  id: unknown,
  options: { fetch?: typeof fetch; rpcUrl?: (chain: string) => string; links?: LinkCheckOptions } = {}
): Promise<EvidenceRead | null> {
  const request = evidenceRequest(kind, id);
  if (!request) return null;

  let subject: EvidenceSubject;
  let counterpartyId: string;
  if (request.kind === "invoice") {
    const row = await maybeOne(db().from("invoices").select("*").eq("id", request.id).limit(1));
    if (!row || row.direction !== "payable") return null;
    const invoice = invoiceOf(row);
    subject = { kind: "invoice", invoice };
    counterpartyId = invoice.counterparty_id;
  } else {
    const row = await maybeOne(db().from("milestones").select("*").eq("id", request.id).limit(1));
    if (!row) return null;
    const milestone = milestoneOf(row);
    subject = { kind: "milestone", milestone };
    counterpartyId = milestone.contractor_id;
  }
  const invoiceId = request.kind === "invoice" ? request.id : null;

  const [counterpartyRow, own, verdicts, compliance, intentRow, receiptRow, people] = await Promise.all([
    maybeOne(db().from("counterparties").select("*").eq("id", counterpartyId).limit(1)),
    ledgerRows(db().rpc("ledger_entries_for_targets", { p_invoice_ids: invoiceId ? [invoiceId] : [], p_milestone_ids: invoiceId ? [] : [request.id] })),
    // A verdict names the payable as its subject, never by invoiceId (shadow mode S3), so it is read on its own.
    invoiceId
      ? ledgerRows(db().from("ledger_entries").select("*").eq("action", "decision_verdict").eq("detail->>subjectId", invoiceId).order("seq", { ascending: true }))
      : Promise.resolve([]),
    ledgerRows(
      db()
        .from("ledger_entries")
        .select("*")
        .eq("domain", "compliance")
        .in("action", COMPLIANCE_ACTIONS)
        .eq("detail->>counterpartyId", counterpartyId)
        .order("seq", { ascending: false })
        .limit(COMPLIANCE_LIMIT)
    ),
    maybeOne(db().from("payment_intents").select(INTENT_COLUMNS).eq("source_type", request.kind).eq("source_id", request.id).limit(1)),
    invoiceId ? maybeOne(db().from("payment_receipts").select("id, entry_seq, created_at, revoked_at, created_by").eq("invoice_id", invoiceId).limit(1)) : Promise.resolve(null),
    memberEmails(),
  ]);

  const receipt: EvidenceReceipt | null = receiptRow
    ? { id: String(receiptRow.id), entry_seq: num(receiptRow.entry_seq), created_at: String(receiptRow.created_at), revoked_at: str(receiptRow.revoked_at), created_by: str(receiptRow.created_by) }
    : null;
  // The receipt's own entries: the one that shared it, by its seq, and the ones that renewed or revoked its link, which
  // name the receipt rather than the invoice.
  const receiptEntries = receipt
    ? (
        await Promise.all([
          ledgerRows(db().from("ledger_entries").select("*").eq("seq", receipt.entry_seq).limit(1)),
          ledgerRows(db().from("ledger_entries").select("*").eq("detail->>receiptId", receipt.id).order("seq", { ascending: true })),
        ])
      ).flat()
    : [];

  const bySeq = new Map<number, EvidenceEntry>();
  for (const entry of [...own, ...verdicts, ...compliance, ...receiptEntries]) bySeq.set(entry.seq, entry);
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const network = workspaceNetwork().id;
  const payment = intentRow ? (intentRow as unknown as EvidencePayment) : null;

  // The payee's screening when the chain's decision was made (or its payment, or now): the newest complete check then.
  const anchors = chainAnchors({ subject, entries, payment, network });
  let screeningQuery = db().from("compliance_checks").select("risk_level, source, screening_mode, created_at").eq("counterparty_id", counterpartyId).eq("status", "complete");
  if (anchors.at) screeningQuery = screeningQuery.lte("created_at", anchors.at);
  const screeningRow = await maybeOne(screeningQuery.order("created_at", { ascending: false }).limit(1));
  const screening: EvidenceScreening | null = screeningRow
    ? { risk_level: String(screeningRow.risk_level), source: String(screeningRow.source), screening_mode: String(screeningRow.screening_mode), created_at: String(screeningRow.created_at) }
    : null;

  // The checks (E4): each entry alone with the workspace's keys, and the transaction on its chain.
  const publicKeys = ledgerPublicKeyPems(ledgerVerificationKeyring());
  const onChainFacts = paymentOnChain({ subject, payment, network });
  const [checked, onChain] = await Promise.all([
    Promise.all(
      entries.map(async (entry): Promise<[number, EntryCheck]> => {
        try {
          return [entry.seq, await verifyEntry(entry, publicKeys)];
        } catch {
          return [entry.seq, { ok: null, reason: "The signature could not be checked here." }];
        }
      })
    ),
    onChainFacts ? readOnChain(onChainFacts, options) : Promise.resolve(null),
  ]);

  const input: EvidenceInput = {
    network,
    subject,
    counterparty: counterpartyOf(counterpartyRow),
    entries,
    screening,
    payment,
    receipt,
    people,
    checks: { entries: new Map(checked), onChain },
  };
  // Built once to find the links it shows, then again with what each link's check said (E1).
  const links = await checkEvidenceLinks(givenLinks(buildEvidenceChain(input)), options.links);
  const chain = buildEvidenceChain({ ...input, checks: { ...input.checks, links } });
  return {
    chain,
    publicKeys,
    receipt: invoiceId ? { state: receipt ? (receipt.revoked_at ? "stopped" : "shared") : chain.subject.onChain ? "none" : "unavailable" } : null,
  };
}
