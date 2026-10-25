import type { OrgRole } from "../auth/roles";
import { orgHref } from "../auth/org-paths";
import { bookingFromEntries } from "../connectors/booked";
import { deciderName, decisionChecks } from "../decision-trail";
import { pullRequestName, type EvidenceScreening } from "../evidence-chain";
import type { EvidenceKey } from "../evidence-export";
import { networkOf, networkProfile, type Network } from "../network";
import { secondPersonOf } from "../payee-lock-evidence";
import { chainById, homeChain } from "../payee-chains";
import { intentFacts as receiptFacts, invoiceNumberInDetail, recordingEntry } from "../receipts/facts";
import type { EntryCheck } from "../receipts/verify";
import { ruleWords } from "../rule-words";
import { PROVIDER_NAMES, providerOfSource } from "../screening/providers";
import { booksOf, settlementOf } from "../settlement-facts";
import { monthEnded, type ClosePackMonth } from "./month";
import type {
  ClosePack,
  ClosePackAddress,
  ClosePackApproval,
  ClosePackApprovalChain,
  ClosePackBill,
  ClosePackCheck,
  ClosePackChecks,
  ClosePackEntry,
  ClosePackEscrowMove,
  ClosePackIntentRow,
  ClosePackInvoiceRow,
  ClosePackLedgerRow,
  ClosePackMilestoneRow,
  ClosePackOpenPayment,
  ClosePackOpenState,
  ClosePackPayee,
  ClosePackRecord,
  ClosePackRow,
  ClosePackSource,
  ClosePackToken,
  ClosePackTotal,
  ClosePackTransaction,
  ClosePackWho,
  Decimal,
} from "./types";
import { whoWords } from "./words";

/**
 * The monthly close pack, built from the rows its reader gathered (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md
 * CP2-CP10): one row per payment Circle confirmed in the month, each with its bill, who decided and approved it, what was
 * checked, the transaction and the signed entry that records it; what was sent and not settled, and the escrow moves,
 * listed apart; and every entry a row cites, carried once in full. Pure: it reads nothing and decides nothing. It reuses
 * the receipt's, the settlement track's and the evidence chain's helpers, so the pack and each evidence page say the same.
 */

export interface ClosePackInput {
  workspace: { slug: string; name: string };
  network: Network;
  month: ClosePackMonth;
  now: Date;
  /** The month's candidate intents (CP2, CP3), at most CLOSE_PACK_MAX_PAYMENTS. */
  intents: readonly ClosePackIntentRow[];
  invoices: readonly ClosePackInvoiceRow[];
  milestones: readonly ClosePackMilestoneRow[];
  counterparties: ReadonlyMap<string, { name: string; address: string | null; sample: boolean }>;
  /** Invoice id to the address its document asked to be paid to (0136); empty before 0136. */
  documentPayTo: ReadonlyMap<string, string>;
  /**
   * Every entry about the bills and milestones, the verdicts on them, their payees' address entries
   * (`create_counterparty`, `counterparty_address_changed`, `counterparty_address_confirmed`, `payee_link_created`),
   * and the month's `escrow_funded` / `escrow_refunded`.
   */
  entries: readonly ClosePackLedgerRow[];
  /** By payment id: the payee's newest complete check at or before `screeningAnchors`' time, null for none, or unread. */
  screening: ReadonlyMap<string, EvidenceScreening | null | "unread">;
  /** `ts` of the workspace's first `compliance_sweep` recording `sanctionedWallets`, or null (CP8). */
  walletListSince: string | null;
  /** By user id; null when they could not be read. */
  members: ReadonlyMap<string, { email: string; role: OrgRole }> | null;
  people: "email" | "id";
  keys: EvidenceKey[];
  ledgerHead: { seq: number; hash: string } | null;
  cut: boolean;
  /** Each cited entry's check, by seq. Absent on the first build, which only finds what is cited. */
  checks?: ReadonlyMap<number, EntryCheck>;
}

/** An entry before its check is given (CP10). */
const NOT_CHECKED_YET: EntryCheck = { ok: null, reason: "Not checked yet." };
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const MILLION = BigInt(1_000_000);
/** The entries that sent a payment's transfer (CP7). */
const PAYING = new Set(["ap_pay", "approval_paid", "milestone_release", "milestone_approval_paid"]);
const PERSON_PAYING = new Set(["approval_paid", "milestone_approval_paid"]);
/** The agent's decisions about a record (CP7). */
const AGENT_DECISIONS = new Set(["ap_pay", "ap_schedule", "ap_hold", "ap_flag_fraud", "ap_request_info", "milestone_release", "milestone_hold"]);
/** The agent's decisions that would pay, whose checks `decisionChecks` reads as a payment's. */
const AGENT_PAYS = new Set(["ap_pay", "ap_schedule", "milestone_release"]);
const CREATION = new Set(["create_invoice", "import_invoice", "recurring_invoice_created"]);
const SET_ADDRESS = new Set(["create_counterparty", "counterparty_address_changed"]);
/** What a transfer ended as when it went out: paid, or in flight (`verified` for a milestone). */
const WENT_OUT = new Set(["paid", "matched", "verified"]);
const FEE_SOURCES = new Set(["chain_reported", "provider_estimate", "simulated_profile"]);
const TOKENS: readonly ClosePackToken[] = ["USDC", "EURC"];
const MEMO_LIMIT = 200;

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const at = (ts: string | null | undefined) => (ts ? Date.parse(ts) : Number.NaN);
const newest = <E extends { seq: number }>(entries: readonly E[], match: (entry: E) => boolean): E | null =>
  entries.filter(match).reduce<E | null>((best, entry) => (best === null || entry.seq > best.seq ? entry : best), null);
const oldest = <E extends { seq: number }>(entries: readonly E[], match: (entry: E) => boolean): E | null =>
  entries.filter(match).reduce<E | null>((best, entry) => (best === null || entry.seq < best.seq ? entry : best), null);

/** An amount in millionths, rounded half up at the seventh place; null for anything that is not an amount (CP6). */
function micros(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  let raw: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    raw = value.toFixed(7);
  } else {
    raw = value.trim();
    if (raw === "") return null;
    if (/e/i.test(raw)) {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return null;
      raw = parsed.toFixed(7);
    }
  }
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const digits = fraction.padEnd(7, "0");
  let units = BigInt(whole) * MILLION + BigInt(digits.slice(0, 6));
  if (Number(digits[6]) >= 5) units += BigInt(1);
  return sign === "-" ? -units : units;
}

function fromMicros(units: bigint): Decimal {
  const negative = units < BigInt(0);
  const size = negative ? -units : units;
  const whole = size / MILLION;
  const fraction = (size % MILLION).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/** An amount as a decimal with exactly six places, "1250.500000"; null for none (CP6). */
export function toDecimal(value: string | number | null | undefined): Decimal | null {
  const units = micros(value);
  return units === null ? null : fromMicros(units);
}

/** "0.1" + "0.2" = "0.300000"; amounts in millionths as BigInt (CP6). */
export function addDecimals(values: ReadonlyArray<string | number>): Decimal {
  return fromMicros(values.reduce<bigint>((sum, value) => sum + (micros(value) ?? BigInt(0)), BigInt(0)));
}

/** `/o/<slug>/evidence/<kind>/<id>`: the payment's own evidence page. */
export function closePackEvidencePath(slug: string, source: ClosePackSource): string {
  return orgHref(slug, `/evidence/${source.kind}/${source.id}`);
}

/** A transaction on its chain's explorer, built from the chain's profile and only for a 32-byte hash (CP9). */
function explorerOf(chain: string | null, hash: string | null): string | null {
  if (!chain || !hash || !TX_HASH.test(hash)) return null;
  try {
    return `${chainById(chain).explorerTx}${hash}`;
  } catch {
    return null;
  }
}

function labelOf(chain: string | null): string | null {
  if (!chain) return null;
  try {
    return chainById(chain).label;
  } catch {
    return null;
  }
}

/** The payment's own network (0075); the workspace's for a value no network has. */
function networkOrDefault(value: string | null, network: Network): Network {
  try {
    return networkOf(value);
  } catch {
    return network;
  }
}

/** The chain a payment's own network pays on directly; Arc's own for a row from before 0075. */
function ownChainOf(intent: ClosePackIntentRow, network: Network): string {
  return intent.chain ?? homeChain(networkOrDefault(intent.network, network)).id;
}

const tokenOf = (value: string | null | undefined): ClosePackToken => (value === "EURC" ? "EURC" : "USDC");

/** Whether a confirmed payment was a sandbox's simulation: by the mode of its result, as the receipt reads it. */
const simulatedIntent = (intent: ClosePackIntentRow) => (intent.provider_mode ?? intent.provider) === "simulate";
const bankIntent = (intent: ClosePackIntentRow) => intent.payout_route === "bank" || (intent.provider_tx_id ?? "").startsWith("blindpay:");

interface Bill {
  source: ClosePackSource;
  invoice: ClosePackInvoiceRow | null;
  milestone: ClosePackMilestoneRow | null;
  counterpartyId: string;
  status: string;
  txRef: string | null;
  settledAt: string | null;
}

/** The payable invoice or milestone a payment pays; "skip" for a receivable; null when it is gone (CP2). */
function billOf(intent: ClosePackIntentRow, invoices: ReadonlyMap<string, ClosePackInvoiceRow>, milestones: ReadonlyMap<string, ClosePackMilestoneRow>): Bill | "skip" | null {
  if (intent.source_type === "invoice") {
    const invoice = invoices.get(intent.source_id);
    if (!invoice) return null;
    if (invoice.direction !== "payable") return "skip";
    return { source: { kind: "invoice", id: invoice.id }, invoice, milestone: null, counterpartyId: invoice.counterparty_id, status: invoice.status, txRef: invoice.tx_ref, settledAt: invoice.settled_at };
  }
  const milestone = milestones.get(intent.source_id);
  if (!milestone) return null;
  return { source: { kind: "milestone", id: milestone.id }, invoice: null, milestone, counterpartyId: milestone.contractor_id, status: milestone.status, txRef: milestone.tx_ref, settledAt: milestone.settled_at };
}

/** The entries about one record, oldest first. */
function ownEntries(entries: readonly ClosePackLedgerRow[], source: ClosePackSource): ClosePackLedgerRow[] {
  const key = source.kind === "invoice" ? "invoiceId" : "milestoneId";
  return entries.filter((entry) => entry.detail[key] === source.id).sort((a, b) => a.seq - b.seq);
}

/** What a paying entry's transfer did when it went out. */
function wentOut(entry: ClosePackLedgerRow): boolean {
  const status = text(record(entry.detail.execution)?.resultingStatus) ?? text(entry.detail.status);
  return status !== null && WENT_OUT.has(status);
}

interface Anchors {
  recording: ClosePackLedgerRow | null;
  paying: ClosePackLedgerRow | null;
  decision: ClosePackLedgerRow | null;
}

interface TransactionFacts {
  transaction: ClosePackTransaction;
  /** The hashes a recording entry may name, the payee's first. */
  refs: string[];
}

/** The transaction that paid the payee (CP9), as a receipt reads it. Links come from the chains' profiles only. */
function transactionOf(intent: ClosePackIntentRow, network: Network, milestone: ClosePackMilestoneRow | null, earlierAttempts: number): TransactionFacts {
  const own = ownChainOf(intent, network);
  const fee = toDecimal(intent.fee_usd);
  const feeSource = intent.fee_source && FEE_SOURCES.has(intent.fee_source) ? (intent.fee_source as ClosePackTransaction["networkFeeSource"]) : null;
  const base: ClosePackTransaction = {
    route: "direct",
    txHash: null,
    chain: null,
    chainLabel: null,
    explorerUrl: null,
    sourceTxHash: null,
    sourceExplorerUrl: null,
    simulatedRef: null,
    note: null,
    networkFeeUsd: fee,
    networkFeeSource: feeSource,
    routeFeeUsdc: null,
    earlierAttempts,
  };
  if (simulatedIntent(intent)) {
    const ref = [intent.tx_hash, intent.provider_tx_id].find((value): value is string => typeof value === "string" && value.startsWith("sim_")) ?? null;
    return { transaction: { ...base, route: "simulated", simulatedRef: ref ? ref.slice(0, 120) : null }, refs: [ref, intent.tx_hash].filter((value): value is string => Boolean(value)) };
  }
  if (bankIntent(intent)) {
    const hash = intent.tx_hash && TX_HASH.test(intent.tx_hash) ? intent.tx_hash : null;
    return {
      transaction: { ...base, route: "bank", txHash: hash, chain: hash ? own : null, chainLabel: hash ? labelOf(own) : null, explorerUrl: explorerOf(own, hash) },
      refs: [intent.tx_hash, intent.provider_tx_id].filter((value): value is string => Boolean(value)),
    };
  }
  const stated = receiptFacts({ ...intent, provider_mode: intent.provider_mode ?? intent.provider });
  const escrow = intent.payout_route === "escrow";
  if (stated.ok) {
    const facts = stated.facts;
    const route: ClosePackTransaction["route"] = escrow ? "escrow" : facts.route;
    const sourceTxHash = facts.sourceTxHash ?? null;
    return {
      transaction: {
        ...base,
        route,
        txHash: facts.txHash,
        chain: facts.chain,
        chainLabel: labelOf(facts.chain),
        explorerUrl: explorerOf(facts.chain, facts.txHash),
        sourceTxHash,
        sourceExplorerUrl: explorerOf(own, sourceTxHash),
        routeFeeUsdc: route === "cctp" || route === "gateway" ? toDecimal(facts.feeUsdc ?? intent.bridge_fee) : null,
      },
      refs: [facts.txHash, ...(sourceTxHash ? [sourceTxHash] : [])],
    };
  }
  // No transaction to show from the intent: a CCTP payout whose mint is not recorded yet, or a hash that does not read.
  const crossChain = intent.destination_chain !== null && intent.destination_chain !== homeChain(networkOrDefault(intent.network, network)).id;
  const route: ClosePackTransaction["route"] = escrow ? "escrow" : intent.payout_route === "gateway" ? "gateway" : crossChain ? "cctp" : "direct";
  const release = escrow && milestone?.escrow_release_tx_hash && TX_HASH.test(milestone.escrow_release_tx_hash) ? milestone.escrow_release_tx_hash : null;
  if (release) {
    return { transaction: { ...base, route, txHash: release, chain: own, chainLabel: labelOf(own), explorerUrl: explorerOf(own, release) }, refs: [release] };
  }
  const chain = route === "cctp" || route === "gateway" ? intent.destination_chain : own;
  const burn = route === "cctp" && intent.tx_hash && TX_HASH.test(intent.tx_hash) ? intent.tx_hash : null;
  return {
    transaction: {
      ...base,
      route,
      chain,
      chainLabel: labelOf(chain),
      sourceTxHash: burn,
      sourceExplorerUrl: explorerOf(own, burn),
      note: stated.reason,
      routeFeeUsdc: route === "cctp" || route === "gateway" ? toDecimal(intent.bridge_fee) : null,
    },
    refs: [intent.mint_tx_hash, intent.tx_hash].filter((value): value is string => Boolean(value)),
  };
}

/**
 * The entry that records the transaction, the one that sent it, and the agent's decision before it (CP7, CP10): the
 * newest recording entry naming the payee's transaction (or the bill's `tx_ref` for a simulated or bank payment); the
 * paying entry is that one, or for a reconcile the newest that sent before it; the decision is the agent's newest at or
 * before the paying entry.
 */
function anchorsOf(bill: Bill, own: readonly ClosePackLedgerRow[], refs: readonly string[]): Anchors {
  const ref = bill.source.kind === "invoice" ? { invoiceId: bill.source.id } : { milestoneId: bill.source.id };
  const candidates = [...refs, ...(bill.txRef ? [bill.txRef] : [])];
  let recording: ClosePackLedgerRow | null = null;
  if (candidates.length > 0) recording = recordingEntry(ref, own, candidates[0], candidates[1] ?? null);
  for (const candidate of candidates.slice(2)) recording ??= recordingEntry(ref, own, candidate, null);
  let paying: ClosePackLedgerRow | null;
  if (recording && PAYING.has(recording.action)) paying = recording;
  else if (recording) {
    const cutoff = recording.seq;
    paying = newest(own, (entry) => PAYING.has(entry.action) && entry.seq < cutoff && wentOut(entry)) ?? newest(own, (entry) => PAYING.has(entry.action) && entry.seq < cutoff);
  } else paying = newest(own, (entry) => PAYING.has(entry.action) && wentOut(entry));
  const cutoff = paying?.seq ?? recording?.seq ?? Number.POSITIVE_INFINITY;
  const decision = newest(own, (entry) => AGENT_DECISIONS.has(entry.action) && entry.seq <= cutoff);
  return { recording, paying, decision };
}

/** Rows and not-settled payments, sorted out of the intents read (CP2, CP3). */
interface Sorted {
  rows: Array<{ intent: ClosePackIntentRow; bill: Bill }>;
  open: Array<{ intent: ClosePackIntentRow; bill: Bill }>;
  withoutBill: number;
}

function sortIntents(input: Pick<ClosePackInput, "intents" | "invoices" | "milestones" | "month">): Sorted {
  const from = Date.parse(`${input.month.from}T00:00:00Z`);
  const to = Date.parse(`${input.month.to}T00:00:00Z`);
  const inMonth = (ts: string | null) => {
    const time = at(ts);
    return !Number.isNaN(time) && time >= from && time < to;
  };
  const invoices = new Map(input.invoices.map((invoice) => [invoice.id, invoice]));
  const milestones = new Map(input.milestones.map((milestone) => [milestone.id, milestone]));
  const sorted: Sorted = { rows: [], open: [], withoutBill: 0 };
  for (const intent of input.intents) {
    // A row of this month: confirmed, with `confirmed_at` in it. Each intent is a row of that one month only (CP2).
    const row = intent.status === "confirmed" && inMonth(intent.confirmed_at);
    // Created or sent in the month and not a row of it (CP3). A payment confirmed before the month is a row of an
    // earlier one; a confirmed payment always carries its `confirmed_at`.
    const open = !row && (inMonth(intent.created_at) || inMonth(intent.submitted_at)) && !(intent.status === "confirmed" && !(at(intent.confirmed_at) >= to));
    if (!row && !open) continue;
    const bill = billOf(intent, invoices, milestones);
    if (bill === "skip") continue;
    if (bill === null) {
      sorted.withoutBill += 1;
      continue;
    }
    (row ? sorted.rows : sorted.open).push({ intent, bill });
  }
  sorted.rows.sort((a, b) => at(a.intent.confirmed_at) - at(b.intent.confirmed_at) || a.intent.id.localeCompare(b.intent.id));
  return sorted;
}

/**
 * For each settled payment, whose screening to read and as of when: the agent's decision, else the paying entry, else
 * when it was sent (CP8). The reader asks for each distinct payee and time once.
 */
export function screeningAnchors(input: Omit<ClosePackInput, "screening" | "checks">): Map<string, { counterpartyId: string; at: string }> {
  const found = new Map<string, { counterpartyId: string; at: string }>();
  for (const { intent, bill } of sortIntents(input).rows) {
    const own = ownEntries(input.entries, bill.source);
    const { refs } = transactionOf(intent, input.network, bill.milestone, 0);
    const anchors = anchorsOf(bill, own, refs);
    found.set(intent.id, { counterpartyId: bill.counterpartyId, at: anchors.decision?.ts ?? anchors.paying?.ts ?? intent.submitted_at ?? intent.created_at });
  }
  return found;
}

const check = (kind: ClosePackCheck["kind"], sentence: string, extra: Partial<ClosePackCheck> = {}): ClosePackCheck => ({
  kind,
  text: sentence,
  notes: [],
  at: null,
  entries: [],
  warn: false,
  ...extra,
});

/** Everything one row needs that the pack shares. */
interface Context {
  input: ClosePackInput;
  who: (id: unknown) => ClosePackWho;
}

function billFacts(bill: Bill, own: readonly ClosePackLedgerRow[]): ClosePackBill {
  if (bill.milestone) {
    const milestone = bill.milestone;
    const created = oldest(own, (entry) => entry.action === "create_milestone");
    return { kind: "milestone", id: milestone.id, title: milestone.title, amount: toDecimal(milestone.amount) ?? "0.000000", currency: "USDC", entry: created?.seq ?? null };
  }
  const invoice = bill.invoice as ClosePackInvoiceRow;
  const created = oldest(own, (entry) => CREATION.has(entry.action));
  const written = record(created?.detail.bill);
  const document = record(created?.detail.document);
  const sha = text(document?.sha256);
  return {
    kind: "invoice",
    id: invoice.id,
    number: created ? invoiceNumberInDetail(created.detail) : null,
    amount: toDecimal(invoice.amount) ?? "0.000000",
    currency: tokenOf(invoice.currency),
    written: written && typeof written.amount === "number" && text(written.currency) ? { amount: written.amount, currency: text(written.currency) as string } : null,
    dueDate: invoice.due_date ? invoice.due_date.slice(0, 10) : null,
    poReference: invoice.po_reference,
    memo: invoice.memo === null ? null : invoice.memo.slice(0, MEMO_LIMIT),
    document: sha ? { sha256: sha, kind: text(document?.kind) } : null,
    vendorDocuments: own
      .filter((entry) => entry.action === "document_received" && text(entry.detail.fileSha256))
      .map((entry) => ({ sha256: text(entry.detail.fileSha256) as string, type: text(entry.detail.fileType), at: entry.ts, entry: entry.seq })),
    entry: created?.seq ?? null,
  };
}

/** Who gave the address paid and who confirmed it, from the payee's entries up to the paying entry (CP7). */
interface AddressFacts {
  address: ClosePackAddress | null;
  /** The newest entry that set an address, and whether it set the one paid. */
  set: ClosePackLedgerRow | null;
  setPaid: boolean;
  confirmed: ClosePackLedgerRow | null;
}

function addressFacts(ctx: Context, counterpartyId: string, destination: string, cutoff: number, applies: boolean): AddressFacts {
  const theirs = ctx.input.entries.filter((entry) => entry.detail.counterpartyId === counterpartyId && entry.seq <= cutoff);
  const set = newest(theirs, (entry) => SET_ADDRESS.has(entry.action));
  const setTo = set ? (set.action === "create_counterparty" ? set.detail.address : set.detail.to) : null;
  const setPaid = set !== null && same(setTo, destination);
  const confirmed = oldest(
    theirs,
    (entry) => entry.action === "counterparty_address_confirmed" && entry.seq > (set?.seq ?? 0) && entry.seq < cutoff && (text(entry.detail.address) === null || same(entry.detail.address, destination))
  );
  if (!applies) return { address: null, set, setPaid, confirmed };
  const mirror = setPaid && set?.detail.via === "mirror";
  const link =
    setPaid && set?.detail.via === "payee_link" && text(set.detail.linkId)
      ? (theirs.find((entry) => entry.action === "payee_link_created" && entry.detail.linkId === set.detail.linkId) ?? null)
      : null;
  const givenBy: ClosePackWho | null = !setPaid || mirror || !set
    ? null
    : set.detail.via === "payee_link"
      ? { kind: "payee_link", linkId: text(set.detail.linkId) }
      : set.detail.via === "github"
        ? { kind: "github", login: text(set.detail.login) }
        : ctx.who(set.detail.by);
  const via = text(confirmed?.detail.via);
  return {
    set,
    setPaid,
    confirmed,
    address: {
      address: destination,
      mirror,
      givenBy,
      givenAt: setPaid && set ? set.ts : null,
      confirmedBy: confirmed ? ctx.who(confirmed.detail.by) : null,
      confirmedAt: confirmed?.ts ?? null,
      confirmedWith: via === "confirm" || via === "approval" ? via : null,
      secondPerson: set && confirmed ? secondPersonOf(set, confirmed) : null,
      entries: [...new Set([...(link ? [link.seq] : []), ...(set ? [set.seq] : []), ...(confirmed ? [confirmed.seq] : [])])].sort((a, b) => a - b),
    },
  };
}

function approvalsOf(ctx: Context, own: readonly ClosePackLedgerRow[], paying: ClosePackLedgerRow | null): ClosePackApproval[] {
  if (!paying || !PERSON_PAYING.has(paying.action)) return [];
  const payer = text(paying.detail.by);
  const listed = Array.isArray(paying.detail.approvals)
    ? (paying.detail.approvals as unknown[]).map(record).filter((approval): approval is Record<string, unknown> => approval !== null && text(approval.by) !== null)
    : [];
  const approvals = listed.length > 0 ? listed : [{ by: payer, at: paying.ts }];
  return approvals.map((approval, index) => {
    const by = text(approval.by);
    const last = index === approvals.length - 1;
    const paid = last && by === payer;
    // The approval's own entry: the paying entry for whoever paid, else the newest approval given for this bill by this
    // person before it, which says whether it was an accountant's co-sign (`approval_paid.approvals` does not).
    const given = paid ? null : newest(own, (entry) => (entry.action === "approval_given" || entry.action === "milestone_approval_given") && entry.seq < paying.seq && text(entry.detail.by) === by);
    const source = paid ? paying : given;
    return {
      who: ctx.who(by),
      at: text(approval.at) ?? source?.ts ?? paying.ts,
      cosign: given?.detail.cosign === true,
      paid,
      via: text(source?.detail.via),
      entry: source?.seq ?? null,
    };
  });
}

function guardrailsCheck(decision: ClosePackLedgerRow | null, personPaid: boolean): ClosePackCheck {
  if (!decision) return check("missing", "No decision of the agent's is recorded.");
  const { notes } = decisionChecks(decision.detail, AGENT_PAYS.has(decision.action));
  const rule = ruleWords(text(decision.detail.guardrailRule));
  const sentence = personPaid
    ? rule
      ? `The agent held it: ${rule}. A person decided to pay it.`
      : "The agent held it for a person. A person decided to pay it."
    : "Code checked it before it was sent.";
  return check("checked", sentence, { notes, at: decision.ts, entries: [decision.seq] });
}

function screeningCheck(screening: EvidenceScreening | null | "unread", name: string, decision: ClosePackLedgerRow | null): ClosePackCheck {
  if (screening === "unread") return check("unreachable", "The screening record could not be read just now.");
  if (screening) {
    const clear = screening.risk_level === "clear";
    const words = clear ? "clear" : `${screening.risk_level} risk`;
    const base = { at: screening.created_at, warn: !clear };
    // OFAC's list of addresses (sanctioned wallets SW4): the payout address itself is on the Treasury's list.
    if (screening.source === "ofac-sdn") return check("contradicted", `${name}'s payout address is on OFAC's SDN list.`, { ...base, warn: true });
    const provider = screening.screening_mode === "live" ? providerOfSource(screening.source) : null;
    if (provider) return check("verified", `${name} was screened ${words} by ${PROVIDER_NAMES[provider].label}.`, base);
    return check("checked", `${name} was screened ${words} against the bundled list, not a screening service.`, base);
  }
  const recorded = text(record(decision?.detail.observed)?.riskLevel);
  if (decision && recorded && recorded !== "unscreened") {
    return check("inferred", `${name} was ${recorded === "clear" ? "clear" : `${recorded} risk`} as the agent's decision recorded; no screening check is on file.`, {
      at: decision.ts,
      entries: [decision.seq],
      warn: recorded !== "clear",
    });
  }
  return check("missing", `${name} was not screened before it was paid.`);
}

function walletListCheck(route: ClosePackTransaction["route"], screening: EvidenceScreening | null | "unread", since: string | null, anchorAt: string): ClosePackCheck {
  if (route === "bank") return check("not_applicable", "A bank payout pays no address on chain.");
  if (route === "simulated") return check("not_applicable", "A simulated payment pays no address.");
  if (screening && screening !== "unread" && screening.source === "ofac-sdn") return check("contradicted", "Its payout address is on OFAC's SDN list.", { at: screening.created_at, warn: true });
  // Since the first sweep that checked the address list, every screening and every payment checks it (SW4-SW6).
  if (since && at(anchorAt) >= at(since)) return check("checked", "Its payout address was not on OFAC's SDN list when it was paid: every screening and payment checks it.", { at: anchorAt });
  return check("missing", "Paid before Vestiarion checked payout addresses against OFAC's SDN list.");
}

const hoursWords = (hours: number) => (hours === 1 ? "1 hour" : `${hours} hours`);

function payeeLockCheck(route: ClosePackTransaction["route"], facts: AddressFacts, sentAt: string): ClosePackCheck {
  if (route === "bank" || !facts.address) return check("not_applicable", "The payee lock covers addresses on chain only.");
  if (facts.address.mirror) return check("not_applicable", "A mirror address Vestiarion made in shadow mode needs no confirmation.");
  const { set, confirmed } = facts;
  if (set && !facts.setPaid) return check("contradicted", "The address paid is not the one the ledger last recorded for this payee.", { at: set.ts, entries: [set.seq], warn: true });
  const entries = [...(set ? [set.seq] : []), ...(confirmed ? [confirmed.seq] : [])];
  if (!confirmed) return check("missing", "No confirmation of this address is recorded before it was paid.", { entries });
  const lock = record(confirmed.detail.payeeLock);
  if (!lock) return check("inferred", "The payee lock was off when the address was confirmed.", { at: confirmed.ts, entries });
  const wait = typeof lock.coolingHours === "number" && lock.coolingHours > 0 ? lock.coolingHours : 0;
  const base = { at: confirmed.ts, entries };
  if (wait === 0) return check("checked", "The payee lock was on when the address was confirmed, with no wait.", base);
  const given = set ? at(set.ts) : Number.NaN;
  const sent = at(sentAt);
  if (Number.isNaN(given) || Number.isNaN(sent)) return check("checked", `The payee lock was on when the address was confirmed, with a ${wait}-hour wait.`, base);
  if (sent < given + wait * 3_600_000) return check("contradicted", `It was sent before the payee lock's ${wait}-hour wait had ended.`, { ...base, warn: true });
  const after = Math.floor((sent - given) / 3_600_000);
  return check(
    "checked",
    `The payee lock was on when the address was confirmed, with a ${wait}-hour wait. It was sent ${after < 1 ? "less than an hour" : hoursWords(after)} after the address was given.`,
    base
  );
}

function payToCheck(bill: Bill, route: ClosePackTransaction["route"], documentPayTo: ReadonlyMap<string, string>, destination: string, paying: ClosePackLedgerRow | null): ClosePackCheck {
  if (!bill.invoice) return check("not_applicable", "A milestone has no invoice document.");
  if (route === "bank") return check("not_applicable", "A bank payout pays no address on chain.");
  const asked = documentPayTo.get(bill.invoice.id);
  if (!asked) return check("not_applicable", "The bill's document named no address of its own.");
  if (same(asked, destination)) return check("checked", "The address its document asked to be paid to is the one paid.");
  // Only a person pays past the invoice's own address (invoice.pay_to_differs): what they chose is stated.
  return check("stated", `Its document asked to be paid to ${asked}; a person chose to pay the address on file.`, {
    at: paying?.ts ?? null,
    entries: paying ? [paying.seq] : [],
    warn: true,
  });
}

function milestoneCheck(ctx: Context, bill: Bill, own: readonly ClosePackLedgerRow[]): ClosePackCheck {
  const milestone = bill.milestone;
  if (!milestone) return check("not_applicable", "A bill has no milestone to verify.");
  const detail = milestone.verification_detail ?? {};
  if (milestone.verification_method === "github" && milestone.verification_status === "verified") {
    const asked = newest(own, (entry) => entry.action === "verify_milestone_github" || entry.action === "github_verification_update");
    // Named as text, never linked: the pack does not run the evidence links' check (evidence access E1).
    const name = pullRequestName(text(detail.pullRequest) ?? milestone.verification_source ?? "");
    return check("verified", `GitHub reported pull request ${name} merged.`, { at: milestone.verified_at ?? text(detail.mergedAt), entries: asked ? [asked.seq] : [] });
  }
  if (milestone.verification_method === "asana" && milestone.verified) {
    const accepted = newest(own, (entry) => entry.action === "milestone_accepted");
    const by = accepted ? whoWords(ctx.who(accepted.detail.by)) : "a member";
    return check("verified", `Asana reported the task completed, and ${by} accepted the work against its criteria.`, {
      at: accepted?.ts ?? milestone.verified_at,
      entries: accepted ? [accepted.seq] : [],
    });
  }
  if (!milestone.verified) return check("missing", "The work was not verified before it was paid.", { warn: true });
  if (milestone.verification_method === "seed") return check("inferred", "Sample data: marked verified as an example.");
  const by = newest(own, (entry) => entry.action === "verify_milestone_manual" || (entry.action === "milestone_approval_paid" && entry.detail.heldFor === "unverified"));
  const who = by && text(by.detail.by) ? ` by ${whoWords(ctx.who(by.detail.by))}` : "";
  return check("stated", `The work was verified by hand${who}.`, { at: by?.ts ?? milestone.verified_at, entries: by ? [by.seq] : [] });
}

function bankOf(intent: ClosePackIntentRow, paying: ClosePackLedgerRow | null): ClosePackPayee["bank"] {
  const payout = record(paying?.detail.payout);
  const account = record(payout?.bankAccount);
  const fromId = (intent.provider_tx_id ?? "").startsWith("blindpay:") ? (intent.provider_tx_id as string).slice("blindpay:".length) : null;
  const receiver = payout?.receiverAmount;
  return {
    provider: "blindpay",
    bankCode: text(account?.bankCode),
    last4: text(account?.last4),
    rail: text(payout?.rail),
    receiverAmount: typeof receiver === "number" || typeof receiver === "string" ? toDecimal(receiver) : null,
    receiverCurrency: text(payout?.currency),
    payoutId: text(payout?.payoutId) ?? fromId,
  };
}

function buildRow(ctx: Context, intent: ClosePackIntentRow, bill: Bill): ClosePackRow {
  const { input } = ctx;
  const own = ownEntries(input.entries, bill.source);
  const settlement = settlementOf({
    intent,
    entries: own,
    source: { type: bill.source.kind, id: bill.source.id },
    books: booksOf({ id: bill.source.id, status: bill.status, tx_ref: bill.txRef, settled_at: bill.settledAt }, bill.source.kind),
    now: input.now.getTime(),
  });
  const { transaction, refs } = transactionOf(intent, input.network, bill.milestone, settlement.earlier.length);
  const { recording, paying, decision } = anchorsOf(bill, own, refs);
  const counterparty = input.counterparties.get(bill.counterpartyId) ?? null;
  const name = counterparty?.name ?? "The payee";
  const route = transaction.route;
  const destination = intent.destination;
  // A sandbox's simulated payee address is no one's: only an address that is the payee's own is traced (CP7).
  const simulatedAddress = route === "simulated" && !(counterparty?.address && same(counterparty.address, destination));
  const cutoff = paying?.seq ?? recording?.seq ?? Number.POSITIVE_INFINITY;
  const address = addressFacts(ctx, bill.counterpartyId, destination, cutoff, route !== "bank" && !simulatedAddress);

  const personPaid = paying !== null && PERSON_PAYING.has(paying.action);
  const approvals = approvalsOf(ctx, own, paying);
  const authorizedBy: ClosePackApprovalChain["authorizedBy"] = !paying ? null : personPaid ? (Array.isArray(paying.detail.approvals) && paying.detail.approvals.length > 1 ? "two_people" : "person") : "code";
  const verdictEntry = decision && bill.invoice ? newest(input.entries, (entry) => entry.action === "decision_verdict" && entry.detail.subjectId === bill.source.id && entry.detail.entrySeq === decision.seq) : null;
  const verdictWord = verdictEntry ? verdictEntry.detail.verdict : null;
  const shadow = decision?.detail.shadow === true || (bill.invoice !== null && input.entries.some((entry) => entry.action === "decision_verdict" && entry.detail.subjectId === bill.source.id));
  const flag = (key: string) => paying?.detail[key] === true;

  const screening = input.screening.get(intent.id) ?? null;
  const sentAt = intent.submitted_at ?? intent.created_at;
  const anchorAt = decision?.ts ?? paying?.ts ?? sentAt;
  const checks: ClosePackChecks = {
    guardrails: guardrailsCheck(decision, personPaid),
    screening: screeningCheck(screening, name, decision),
    walletList: walletListCheck(route, screening, input.walletListSince, anchorAt),
    payeeLock: payeeLockCheck(route, address, paying?.ts ?? sentAt),
    payTo: payToCheck(bill, route, input.documentPayTo, destination, paying),
    milestone: milestoneCheck(ctx, bill, own),
  };

  const billed = billFacts(bill, own);
  const amount = toDecimal(bill.invoice?.paid_amount ?? null) ?? toDecimal(intent.amount) ?? "0.000000";
  const off = bill.invoice ? (micros(bill.invoice.amount) ?? BigInt(0)) - (micros(amount) ?? BigInt(0)) : BigInt(0);
  const booking = bill.invoice ? bookingFromEntries(own, bill.invoice.id) : null;
  const recordFacts: ClosePackRecord | null = recording
    ? {
        seq: recording.seq,
        action: recording.action,
        ts: recording.ts,
        hash: recording.hash,
        signature: recording.signature,
        signingKeyId: recording.signing_key_id ?? null,
        check: input.checks?.get(recording.seq) ?? NOT_CHECKED_YET,
      }
    : null;

  const approval: ClosePackApprovalChain = {
    authorizedBy,
    agent: decision
      ? {
          action: decision.action,
          decider: deciderName(decision.detail.decisionMode),
          guardrailRule: text(decision.detail.guardrailRule),
          shadow: decision.detail.shadow === true,
          at: decision.ts,
          entry: decision.seq,
        }
      : null,
    approvals,
    verdict: verdictEntry && (verdictWord === "agree" || verdictWord === "disagree") ? { verdict: verdictWord, who: ctx.who(verdictEntry.detail.by), at: verdictEntry.ts, entry: verdictEntry.seq } : null,
    flags: { soleApprover: flag("soleApprover"), addressGiverApproved: flag("addressGiverApproved"), firstPayment: flag("firstPayment"), fewApprovers: flag("fewApprovers") },
    address: address.address,
  };

  const cited = new Set<number>([
    ...(billed.entry !== null ? [billed.entry] : []),
    ...(billed.kind === "invoice" ? billed.vendorDocuments.map((document) => document.entry) : []),
    ...(approval.agent ? [approval.agent.entry] : []),
    ...approvals.flatMap((one) => (one.entry !== null ? [one.entry] : [])),
    ...(approval.verdict ? [approval.verdict.entry] : []),
    ...(approval.address?.entries ?? []),
    ...(paying ? [paying.seq] : []),
    ...Object.values(checks).flatMap((one) => one.entries),
    ...(recording ? [recording.seq] : []),
    ...(booking ? [booking.seq] : []),
  ]);

  return {
    paymentId: intent.id,
    source: bill.source,
    paidAt: intent.confirmed_at as string,
    sentAt,
    amount,
    token: bill.milestone ? "USDC" : tokenOf(intent.token ?? bill.invoice?.currency),
    discount: off > BigInt(0) ? fromMicros(off) : null,
    simulated: route === "simulated",
    shadow,
    payee: {
      counterpartyId: bill.counterpartyId,
      name: counterparty?.name ?? null,
      address: route === "bank" ? null : destination,
      bank: route === "bank" ? bankOf(intent, paying) : null,
    },
    bill: billed,
    approval,
    checks,
    transaction,
    record: recordFacts,
    books: {
      markedPaid: bill.status === "paid",
      mismatch: settlement.mismatch,
      booked: booking ? { tool: booking.label, state: booking.state, paymentId: booking.paymentId, at: booking.at, entry: booking.seq } : null,
    },
    evidencePath: closePackEvidencePath(input.workspace.slug, bill.source),
    entries: [...cited].sort((a, b) => a - b),
  };
}

/** A payment sent in the month and not settled in it, with its state (CP3). */
function openPayment(ctx: Context, intent: ClosePackIntentRow, bill: Bill): ClosePackOpenPayment {
  const { input } = ctx;
  const counterparty = input.counterparties.get(bill.counterpartyId) ?? null;
  const own = ownEntries(input.entries, bill.source);
  let state: ClosePackOpenState;
  if (intent.status === "confirmed") state = "settled_later";
  else if ((intent.provider_tx_id ?? "").startsWith("blindpay:") && intent.provider_state === "FAILED") state = "refunded";
  else {
    const settlement = settlementOf({
      intent,
      entries: own,
      source: { type: bill.source.kind, id: bill.source.id },
      books: booksOf({ id: bill.source.id, status: bill.status, tx_ref: bill.txRef, settled_at: bill.settledAt }, bill.source.kind),
      now: input.now.getTime(),
    });
    const status = settlement.status;
    state = status === "confirmed" || status === "reconciled" ? "in_flight" : status;
  }
  const circle = [intent.provider_state, intent.failure_reason].filter((part): part is string => Boolean(part)).join(": ");
  const error = intent.last_error?.trim().replace(/\.$/, "") || null;
  const reason = state === "not_sent" || state === "unknown" ? error : state === "waiting" || state === "settled_later" ? null : circle || error;
  const own_chain = ownChainOf(intent, input.network);
  let txHash: string | null = null;
  let explorerUrl: string | null = null;
  if (!simulatedIntent(intent)) {
    const stated = intent.status === "confirmed" ? receiptFacts({ ...intent, provider_mode: intent.provider_mode ?? intent.provider }) : null;
    if (stated?.ok) {
      txHash = stated.facts.txHash;
      explorerUrl = explorerOf(stated.facts.chain, stated.facts.txHash);
    } else if (intent.tx_hash && TX_HASH.test(intent.tx_hash)) {
      txHash = intent.tx_hash;
      explorerUrl = explorerOf(own_chain, intent.tx_hash);
    }
  }
  return {
    paymentId: intent.id,
    source: bill.source,
    payee: { counterpartyId: bill.counterpartyId, name: counterparty?.name ?? null },
    amount: toDecimal(bill.invoice?.paid_amount ?? null) ?? toDecimal(intent.amount) ?? "0.000000",
    token: bill.milestone ? "USDC" : tokenOf(intent.token ?? bill.invoice?.currency),
    simulated: simulatedIntent(intent) && intent.status !== "submitting",
    state,
    sentAt: intent.status === "created" ? null : (intent.submitted_at ?? intent.executed_at ?? intent.created_at),
    settledAt: state === "settled_later" ? intent.confirmed_at : null,
    reason,
    txHash,
    explorerUrl,
    evidencePath: closePackEvidencePath(input.workspace.slug, bill.source),
  };
}

/** The month's escrow locks and refunds (CP4): a lock pays no one, so neither is in the totals. */
function escrowMoves(input: ClosePackInput): ClosePackEscrowMove[] {
  const from = Date.parse(`${input.month.from}T00:00:00Z`);
  const to = Date.parse(`${input.month.to}T00:00:00Z`);
  const titles = new Map(input.milestones.map((milestone) => [milestone.id, milestone.title]));
  const own = homeChain(input.network).id;
  const seen = new Set<number>();
  return [...input.entries]
    .filter((entry) => (entry.action === "escrow_funded" || entry.action === "escrow_refunded") && at(entry.ts) >= from && at(entry.ts) < to)
    .filter((entry) => (seen.has(entry.seq) ? false : (seen.add(entry.seq), true)))
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => {
      const funded = entry.action === "escrow_funded";
      const milestoneId = text(entry.detail.milestoneId) ?? "";
      const raw = funded ? entry.detail.fundTxHash : entry.detail.refundTxHash;
      const hash = typeof raw === "string" && TX_HASH.test(raw) ? raw : null;
      const amount = entry.detail.amountUsdc;
      return {
        kind: funded ? ("funded" as const) : ("refunded" as const),
        at: entry.ts,
        milestoneId,
        title: titles.get(milestoneId) ?? null,
        amount: (typeof amount === "number" || typeof amount === "string" ? toDecimal(amount) : null) ?? "0.000000",
        txHash: hash,
        explorerUrl: explorerOf(own, hash),
        entry: entry.seq,
      };
    });
}

function totalsOf(rows: readonly ClosePackRow[]): ClosePackTotal[] {
  return TOKENS.flatMap((token) => {
    const mine = rows.filter((row) => row.token === token);
    if (mine.length === 0) return [];
    return [
      {
        token,
        payments: mine.length,
        amount: addDecimals(mine.map((row) => row.amount)),
        // A route's fee is the payment's own; a network fee is the batch's, so it is listed and never summed (CP6).
        routeFeesUsdc: addDecimals(mine.flatMap((row) => (row.transaction.routeFeeUsdc ? [row.transaction.routeFeeUsdc] : []))),
      },
    ];
  });
}

/** A cited entry in full, as the evidence export carries it, with the server's check (CP10). */
function entryOf(entry: ClosePackLedgerRow, checks: ReadonlyMap<number, EntryCheck> | undefined): ClosePackEntry {
  return {
    seq: entry.seq,
    id: entry.id ?? null,
    ts: entry.ts,
    actor: entry.actor,
    domain: entry.domain,
    action: entry.action,
    summary: entry.summary,
    detail: entry.detail,
    body_hash: entry.body_hash,
    signature: entry.signature,
    prev_hash: entry.prev_hash,
    hash: entry.hash,
    signing_key_id: entry.signing_key_id ?? null,
    check: checks?.get(entry.seq) ?? NOT_CHECKED_YET,
  };
}

export function buildClosePack(input: ClosePackInput): ClosePack {
  const members = input.members;
  const people = input.people;
  // By email for a person's page and files; by id for the API (CP18). Someone no longer a member is named by id; when
  // the members could not be read, no one is guessed to have left.
  const who = (id: unknown): ClosePackWho => {
    const userId = text(id);
    if (!userId) return { kind: "unknown" };
    if (members === null) return { kind: "member", userId, email: null, roleNow: null };
    const member = members.get(userId);
    if (!member) return { kind: "former_member", userId };
    return { kind: "member", userId, email: people === "email" ? member.email : null, roleNow: member.role };
  };
  const ctx: Context = { input, who };
  const sorted = sortIntents(input);
  const rows = sorted.rows.map(({ intent, bill }) => buildRow(ctx, intent, bill));
  const notSettled = sorted.open.map(({ intent, bill }) => openPayment(ctx, intent, bill));
  const escrow = escrowMoves(input);

  const cited = new Set<number>([...rows.flatMap((row) => row.entries), ...escrow.map((move) => move.entry)]);
  const bySeq = new Map<number, ClosePackLedgerRow>();
  for (const entry of input.entries) if (cited.has(entry.seq) && !bySeq.has(entry.seq)) bySeq.set(entry.seq, entry);
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq).map((entry) => entryOf(entry, input.checks));

  const notSettledCounts: Partial<Record<ClosePackOpenState, number>> = {};
  for (const payment of notSettled) notSettledCounts[payment.state] = (notSettledCounts[payment.state] ?? 0) + 1;
  const onChain = rows.filter((row) => !row.simulated);
  const unread: ClosePack["unread"] = [];
  if (members === null) unread.push("members");
  if ([...input.screening.values()].some((value) => value === "unread")) unread.push("screening");

  return {
    workspace: { slug: input.workspace.slug, name: input.workspace.name },
    network: { id: input.network, label: networkProfile(input.network).label },
    month: input.month,
    ended: monthEnded(input.month, input.now),
    readAt: input.now.toISOString(),
    ledgerHead: input.ledgerHead,
    cut: input.cut,
    unread,
    people,
    totals: {
      onChain: totalsOf(onChain),
      simulated: totalsOf(rows.filter((row) => row.simulated)),
      shadow: onChain.filter((row) => row.shadow).length,
      notSettled: notSettledCounts,
      withoutBill: sorted.withoutBill,
      entries: {
        cited: entries.length,
        verified: entries.filter((entry) => entry.check?.ok === true).length,
        failed: entries.filter((entry) => entry.check?.ok === false).length,
        unchecked: entries.filter((entry) => entry.check === null || entry.check.ok === null).length,
      },
    },
    rows,
    notSettled,
    escrow,
    keys: input.keys,
    entries,
  };
}

