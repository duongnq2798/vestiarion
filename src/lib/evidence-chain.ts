/**
 * Why it was paid (docs/superpowers/specs/2026-10-10-evidence-chain-design.md): one chain per payable or milestone,
 * from what was agreed to the signatures, each fact labelled by how it is known (E3). Pure: `readEvidence`
 * (./evidence-read) reads the records and runs the checks; this decides what they say.
 *
 * A label is decided by where a fact came from, never by the entry that recorded it: goods a person marked received
 * stay "Stated by a person" though their entry is signed. A step reads as its weakest fact.
 */

import { bookingFromEntries } from "./connectors/booked";
import { utcDay, utcMinute } from "./copy";
import { deciderName, decisionChecks, PAYMENT_HELD_AGAIN, PAYMENT_SENT, trailStep } from "./decision-trail";
import { MIRROR, PAYEE, addressProvenance } from "./new-payee";
import { networkOf, networkProfile, type Network } from "./network";
import { chainById, homeChain } from "./payee-chains";
import { intentFacts, recordingEntry, RECORDING_ACTIONS, type ReceiptFacts, type ReceiptIntent } from "./receipts/facts";
import type { OnChainCheck } from "./receipts/onchain";
import { recordsTransaction, type EntryCheck, type PublicLedgerRow } from "./receipts/verify";

/** How a fact is known: five ways of knowing, and two outcomes of a check we make (E3). */
export type EvidenceKind = "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted";

export const EVIDENCE_WORDS: Readonly<Record<EvidenceKind, string>> = {
  checked: "Checked by code",
  verified: "Verified outside",
  stated: "Stated by a person",
  inferred: "Inferred",
  missing: "Missing",
  unreachable: "Could not open",
  contradicted: "Does not match",
};

/** What each word means, in one sentence: the page explains them once, and the download carries them (E3). */
export const EVIDENCE_MEANINGS: Readonly<Record<EvidenceKind, string>> = {
  checked: "A rule Vestiarion runs computed it: the three-way match, the guardrails, a signature, the written policy.",
  verified: "Someone outside Vestiarion answered: the chain's record of the transaction, GitHub, the screening service.",
  stated: "A member or the payee entered it. The page names who, and when.",
  inferred: "Read, not recorded: the model's judgement, sample data, or a setting as it is today.",
  missing: "Nothing records it. Where it can still be added, the page says how.",
  unreachable: "A check got no answer, or a link was revoked: it never counts as verified.",
  contradicted: "A check answered, and its answer contradicts the record.",
};

/** Weakest first: a step reads as the first of these its facts hold, so it is never labelled above its least-supported fact. */
export const EVIDENCE_ORDER: readonly EvidenceKind[] = ["contradicted", "unreachable", "missing", "inferred", "stated", "checked", "verified"];

export function weakest(kinds: readonly EvidenceKind[]): EvidenceKind {
  return EVIDENCE_ORDER.find((kind) => kinds.includes(kind)) ?? "missing";
}

/** What a signature does and does not prove, in one plain line (E3). */
export const SIGNED_ENTRY_PROVES = "A signed entry proves who recorded what, and when. It does not prove the goods were good or the work was done.";

/** A ledger entry as the chain reads it: its whole signed body, so each can be checked alone. */
export type EvidenceEntry = PublicLedgerRow & { ts: string; id?: string };

/** A link a fact points to (E4): checked here, shown without being opened, unanswered, or contradicting the record. */
export interface EvidenceLink {
  href: string;
  label: string;
  state: "checked" | "not_opened" | "unreachable" | "contradicted";
}

export interface EvidenceFact {
  kind: EvidenceKind;
  /** One sentence. */
  text: string;
  /** Who stated it: a member's email, "a former member", "the payee"; null when the ledger names no one. */
  who?: string | null;
  /** When it was stated, checked or recorded. */
  at?: string | null;
  /** For a missing fact: what would fill it. */
  fill?: string;
  /** Short lines under it: a decision's checks, what Arc answered. */
  notes?: string[];
  /** The signed entries it rests on. */
  seqs: number[];
  link?: EvidenceLink;
  /** What it says is bad news, however well it is known: screened high risk, a transfer that failed. */
  warn?: boolean;
}

export type EvidenceStepId = "agreed" | "delivered" | "bill" | "payee" | "decision" | "people" | "payment" | "books" | "receipt" | "signatures";

export interface EvidenceStep {
  id: EvidenceStepId;
  title: string;
  kind: EvidenceKind;
  facts: EvidenceFact[];
  /** The decision step's way into the decision trail on Bills & receivables; null for a milestone, which has no trail, and a payable no entry is about. */
  trail?: { invoiceId: string } | null;
  /** The signatures step's plain line. */
  caveat?: string;
}

export interface EvidenceInvoice {
  id: string;
  direction: string;
  counterparty_id: string;
  amount: number;
  currency?: string | null;
  memo: string | null;
  po_reference: string | null;
  goods_received: boolean;
  due_date: string;
  status: string;
  tx_ref: string | null;
  /** What left when it was paid (0038): less than `amount` when the early-payment discount took part of it off. */
  paid_amount?: number | null;
}

export interface EvidenceMilestone {
  id: string;
  contractor_id: string;
  title: string;
  amount: number;
  status: string;
  verified: boolean;
  verification_method: string;
  verification_status: string;
  verification_source: string | null;
  verification_checked_at: string | null;
  verified_at: string | null;
  verification_detail: Record<string, unknown> | null;
  tx_ref: string | null;
  escrow_state?: string | null;
  escrow_payee?: string | null;
  escrow_amount?: number | string | null;
  escrow_release_tx_hash?: string | null;
}

export interface EvidenceCounterparty {
  id: string;
  name: string;
  address: string | null;
  chain: string | null;
  risk_level: string;
  purchase_order_required?: boolean;
  sample: boolean;
}

/** The newest complete screening check at or before the payment's decision (E5). */
export interface EvidenceScreening {
  risk_level: string;
  source: string;
  screening_mode: string;
  created_at: string;
}

/** The record's payment intent, as the receipt reads it, and its provider. */
export type EvidencePayment = ReceiptIntent & { provider: string };

/** The record's receipt row (payment receipts P3); the link itself is never stored, only its hash. */
export interface EvidenceReceipt {
  /** Its id, which its later entries name (`receipt_link_renewed`, `receipt_revoked`). */
  id: string;
  entry_seq: number;
  created_at: string;
  revoked_at: string | null;
  created_by: string | null;
}

export type EvidenceSubject = { kind: "invoice"; invoice: EvidenceInvoice } | { kind: "milestone"; milestone: EvidenceMilestone };

export interface EvidenceInput {
  /** The workspace's network. */
  network: Network;
  subject: EvidenceSubject;
  counterparty: EvidenceCounterparty | null;
  /**
   * Every entry read for the record: those about it, the verdicts on its decisions, its counterparty's address,
   * purchase-order and screening entries, and its receipt's.
   */
  entries: readonly EvidenceEntry[];
  screening: EvidenceScreening | null;
  payment: EvidencePayment | null;
  receipt: EvidenceReceipt | null;
  /** Members' emails by user id; null when they could not be read, so a person is "a member" (E5). */
  people: ReadonlyMap<string, string> | null;
  checks: {
    /** Each entry's check (`verifyEntry`), by seq. */
    entries: ReadonlyMap<number, EntryCheck>;
    /** Arc's record of the payment's transaction; null when there is none to read. */
    onChain: OnChainCheck | null;
  };
}

export interface EvidenceChain {
  subject: {
    kind: EvidenceSubject["kind"];
    id: string;
    title: string;
    payee: string;
    /** The bill's or the milestone's amount. */
    amount: number;
    /**
     * What was paid, when the early-payment discount took part of the bill off: less than `amount`. Null when the whole
     * amount was paid, and for anything not paid.
     */
    paidAmount: number | null;
    currency: string;
    status: string;
    paid: boolean;
    /** Rejected by a person (a payable) or closed without paying (a milestone): it will not be paid. */
    closed: boolean;
    /** Marked paid by a simulated transfer: nothing moved on chain. */
    simulated: boolean;
    /** Paid by a transaction on chain the chain shows: the only payment a receipt can be shared for. */
    onChain: boolean;
  };
  network: Network;
  steps: EvidenceStep[];
  /** How many facts are known each way. */
  tally: Record<EvidenceKind, number>;
  /** Every entry the chain rests on, oldest first, with its check. */
  entries: Array<EvidenceEntry & { check: EntryCheck }>;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CREATION = new Set(["create_invoice", "import_invoice", "recurring_invoice_created"]);
const SET_ADDRESS = new Set(["create_counterparty", "counterparty_address_changed"]);
const PAYING = new Set(["ap_pay", "ap_schedule", "milestone_release"]);
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const money = (amount: number, currency: string) => `${AMOUNT.format(amount)} ${currency}`;
const short = (value: string) => (value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);
const sameAddress = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const pad = (seq: number) => `#${String(seq).padStart(4, "0")}`;

/** Where a person's action came through, when not the console (provenance R3), as a phrase after the verb. */
function via(detail: Record<string, unknown>): string {
  switch (detail.via) {
    case "telegram":
      return " from Telegram";
    case "slack":
      return " from Slack";
    case "api":
      return " through the API";
    case "github":
      return " on GitHub";
    case "email":
      return " from an emailed invoice";
    case "import":
      return " from an imported list";
    case "xero":
      return " in the review of bills from Xero";
    default:
      return "";
  }
}

/** " as bill PD-4471", the number Xero gave the bill, when the entry kept one. */
function xeroNumber(detail: Record<string, unknown>): string {
  const ids = record(detail.xero);
  const number = ids ? text(ids.invoiceNumber) : null;
  return number ? ` as bill ${number}` : "";
}

/** "acme/app#12" for a pull request's URL; the URL itself otherwise. */
function pullRequestName(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}#${match[3]}` : url;
}

/** A link a person typed, shown and never opened (E4); null for anything but an https address. */
function typedLink(value: string | null): EvidenceLink | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? { href: url.href, label: url.hostname, state: "not_opened" } : null;
  } catch {
    return null;
  }
}

/** The newest entry that matches. */
function newest<E extends { seq: number }>(entries: readonly E[], match: (entry: E) => boolean): E | null {
  return entries.filter(match).sort((a, b) => b.seq - a.seq)[0] ?? null;
}

function oldest<E extends { seq: number }>(entries: readonly E[], match: (entry: E) => boolean): E | null {
  return entries.filter(match).sort((a, b) => a.seq - b.seq)[0] ?? null;
}

/** An agent's decision about the record: one with the model's or the policy's `decision`, never a reconcile. */
function isAgentDecision(entry: EvidenceEntry): boolean {
  return entry.actor === "agent" && record(entry.detail.decision) !== null && !entry.action.endsWith("reconcile");
}

type PaymentView =
  | { state: "chain"; facts: ReceiptFacts; recording: EvidenceEntry | null }
  | { state: "recorded"; txHash: string; recording: EvidenceEntry | null }
  | { state: "simulated" | "in_flight" | "failed" | "no_record" | "unpaid" }
  | { state: "unready"; reason: string };

/**
 * The payment on chain, when there is one to read: a confirmed live intent's transaction (as its receipt reads it), or a
 * milestone's release from escrow. `readEvidence` reads Arc's record of the same transaction.
 */
export function paymentOnChain(input: Pick<EvidenceInput, "subject" | "payment" | "network">): ReceiptFacts | null {
  if (input.payment) {
    const stated = intentFacts(input.payment);
    return stated.ok ? stated.facts : null;
  }
  if (input.subject.kind !== "milestone") return null;
  const milestone = input.subject.milestone;
  const tx = milestone.escrow_release_tx_hash;
  const payee = milestone.escrow_payee;
  if (milestone.escrow_state !== "released" || !tx || !TX_HASH.test(tx) || !payee || !ADDRESS.test(payee)) return null;
  return { amount: Number(milestone.escrow_amount ?? milestone.amount), token: "USDC", paidAt: "", payee, chain: homeChain(input.network).id, txHash: tx, route: "direct" };
}

interface Context {
  input: EvidenceInput;
  key: "invoiceId" | "milestoneId";
  id: string;
  name: string;
  paid: boolean;
  /** Rejected or closed: it will not be paid. */
  closed: boolean;
  /** The record's amount and its currency. */
  amount: number;
  currency: string;
  /** What was paid, when the early-payment discount took part of the bill off; null otherwise. */
  paidAmount: number | null;
  /** The entries about the record, oldest first. */
  own: EvidenceEntry[];
  /** The counterparty's entries up to the payment, newest first. */
  counterparty: EvidenceEntry[];
  payment: PaymentView;
  /** The agent's decision that paid it, or its newest before a person did, or its newest of all while open. */
  decision: EvidenceEntry | null;
  who: (id: unknown) => string | null;
  networkLabel: string;
}

function paymentView(input: Pick<EvidenceInput, "subject" | "payment" | "network">, own: EvidenceEntry[], status: string, txRef: string | null, ref: { invoiceId: string } | { milestoneId: string }): PaymentView {
  const onChain = paymentOnChain(input);
  if (onChain) return { state: "chain", facts: onChain, recording: recordingEntry(ref, own, onChain.txHash, onChain.sourceTxHash ?? null) };
  const intent = input.payment;
  if (intent) {
    if (intent.status === "failed") return { state: "failed" };
    if (intent.status !== "confirmed") return { state: "in_flight" };
    if (intent.provider !== "circle" || intent.provider_mode !== "live") return { state: "simulated" };
    const stated = intentFacts(intent);
    return { state: "unready", reason: stated.ok ? "" : stated.reason };
  }
  if (txRef?.startsWith("sim_")) return { state: "simulated" };
  if (txRef && TX_HASH.test(txRef)) return { state: "recorded", txHash: txRef, recording: recordingEntry(ref, own, txRef, null) };
  return status === "paid" ? { state: "no_record" } : { state: "unpaid" };
}

function stated(ctx: Context, sentence: string, entry: EvidenceEntry | null, extra: Partial<EvidenceFact> = {}): EvidenceFact {
  return { kind: "stated", text: sentence, who: entry ? ctx.who(entry.detail.by) : null, at: entry?.ts ?? null, seqs: entry ? [entry.seq] : [], ...extra };
}

function step(id: EvidenceStepId, title: string, facts: EvidenceFact[], extra: Partial<EvidenceStep> = {}): EvidenceStep {
  return { id, title, kind: weakest(facts.map((fact) => fact.kind)), facts, ...extra };
}

/** 1. What was agreed: the purchase order, or that none is needed; a milestone's terms. */
function agreedInvoice(ctx: Context, invoice: EvidenceInvoice): EvidenceStep {
  const title = "What was agreed";
  const po = invoice.po_reference;
  if (po) {
    const source = newest(ctx.own, (entry) => (entry.action === "invoice_details_added" && record(entry.detail.added)?.poReference === po) || (CREATION.has(entry.action) && entry.detail.poReference === po));
    if (!source && ctx.input.counterparty?.sample) return step("agreed", title, [{ kind: "inferred", text: `Purchase order ${po} is on the bill, loaded with the sample data.`, seqs: [] }]);
    return step("agreed", title, [stated(ctx, `Purchase order ${po} is on the bill${source ? via(source.detail) : ""}.`, source)]);
  }
  const observed = record(ctx.decision?.detail.observed);
  const recordedNone = observed?.purchaseOrderRequired === false;
  if (recordedNone || (observed?.purchaseOrderRequired === undefined && ctx.input.counterparty?.purchase_order_required === false)) {
    const marked = newest(ctx.counterparty, (entry) => entry.action === "counterparty_purchase_orders_changed" && entry.detail.to === false);
    const facts: EvidenceFact[] = [];
    if (marked || recordedNone) facts.push(stated(ctx, `No purchase order is needed: ${ctx.name} is marked as paid without purchase orders.`, marked));
    else facts.push({ kind: "inferred", text: `No purchase order is needed: ${ctx.name} is marked as paid without purchase orders today.`, seqs: [] });
    if (recordedNone && ctx.decision) facts.push({ kind: "checked", text: "The agent's decision recorded that none was needed.", at: ctx.decision.ts, seqs: [ctx.decision.seq] });
    return step("agreed", title, facts);
  }
  return step("agreed", title, [
    {
      kind: "missing",
      text: "No purchase order is on file.",
      fill: ctx.paid
        ? "None was on the bill when it was paid. Keep the purchase order with the books if there is one."
        : ctx.closed
          ? "None was on the bill."
          : "Add the purchase order with Add details on Bills & receivables, or mark the counterparty as paid without purchase orders on Counterparties.",
      seqs: [],
    },
  ]);
}

function agreedMilestone(ctx: Context, milestone: EvidenceMilestone): EvidenceStep {
  const title = "What was agreed";
  const created = oldest(ctx.own, (entry) => entry.action === "create_milestone");
  const bounty = oldest(ctx.own, (entry) => entry.action === "github_bounty_attached");
  const terms = `“${milestone.title}”, ${money(milestone.amount, "USDC")} for ${ctx.name}`;
  if (bounty) {
    const pr = text(bounty.detail.pullRequest);
    const comment = typedLink(text(bounty.detail.commentUrl));
    return step("agreed", title, [
      {
        kind: "stated",
        text: `${terms}, attached as a bounty on GitHub${pr ? ` to ${pullRequestName(pr)}` : ""}.`,
        who: text(bounty.detail.login) ? `@${text(bounty.detail.login)} on GitHub` : null,
        at: bounty.ts,
        seqs: [bounty.seq, ...(created ? [created.seq] : [])],
        ...(comment ? { link: { ...comment, label: "The comment on GitHub" } } : {}),
      },
    ]);
  }
  if (created) return step("agreed", title, [stated(ctx, `${terms}, added${via(created.detail) || " on Contractors"}.`, created)]);
  if (ctx.input.counterparty?.sample) return step("agreed", title, [{ kind: "inferred", text: "Loaded with the sample data; it has no ledger entry of its own.", seqs: [] }]);
  return step("agreed", title, [{ kind: "missing", text: "No entry records who added this milestone.", fill: "A milestone added on Contractors, through the API or by a bounty on GitHub records it.", seqs: [] }]);
}

/** 2. What was delivered: goods marked received; a milestone's verification. */
function deliveredInvoice(ctx: Context, invoice: EvidenceInvoice): EvidenceStep {
  const title = "What was delivered";
  if (invoice.goods_received) {
    const source = newest(ctx.own, (entry) => (entry.action === "invoice_details_added" && record(entry.detail.added)?.goodsReceived === true) || (CREATION.has(entry.action) && entry.detail.goodsReceived === true));
    if (!source && ctx.input.counterparty?.sample) return step("delivered", title, [{ kind: "inferred", text: "The goods or services are marked received, loaded with the sample data.", seqs: [] }]);
    const sentence = source?.action === "recurring_invoice_created" ? "The goods or services are marked received by its recurring schedule." : `The goods or services are marked received${source ? via(source.detail) : ""}.`;
    return step("delivered", title, [stated(ctx, sentence, source)]);
  }
  return step("delivered", title, [
    {
      kind: "missing",
      text: "Nothing records that the goods or services were received.",
      fill: ctx.paid || ctx.closed ? "Nothing more can be added to it here." : "A person marks them received with Add details on Bills & receivables.",
      seqs: [],
    },
  ]);
}

function deliveredMilestone(ctx: Context, milestone: EvidenceMilestone): EvidenceStep {
  const title = "What was delivered";
  const detail = milestone.verification_detail ?? {};
  if (milestone.verification_method === "github") {
    const source = text(detail.pullRequest) ?? milestone.verification_source ?? "";
    const name = pullRequestName(source);
    const asked = newest(ctx.own, (entry) => entry.action === "verify_milestone_github" || entry.action === "github_verification_update");
    const link = (state: EvidenceLink["state"]): EvidenceLink | undefined => (source.startsWith("https://") ? { href: source, label: name, state } : undefined);
    const seqs = asked ? [asked.seq] : [];
    switch (milestone.verification_status) {
      case "verified":
        return step("delivered", title, [
          {
            kind: "verified",
            text: `GitHub reported pull request ${name} merged.`,
            at: milestone.verified_at ?? text(detail.mergedAt),
            notes: milestone.verification_checked_at ? [`Vestiarion asked GitHub on ${utcMinute(milestone.verification_checked_at)}.`] : [],
            seqs,
            link: link("checked"),
          },
        ]);
      case "not_merged":
        return step("delivered", title, [
          { kind: "missing", text: `Pull request ${name} was not merged when GitHub was last asked.`, fill: "The agent pays it once GitHub reports it merged.", seqs, link: link("checked"), warn: true },
        ]);
      case "unavailable":
      case "failed":
        return step("delivered", title, [
          { kind: "unreachable", text: `GitHub could not be asked about pull request ${name}${text(detail.error) ? `: ${text(detail.error)}` : ""}.`, at: milestone.verification_checked_at, seqs, link: link("unreachable") },
        ]);
      default:
        return step("delivered", title, [{ kind: "missing", text: `Pull request ${name} has not been checked with GitHub yet.`, fill: "The agent asks GitHub before each payment cycle.", seqs, link: link("not_opened") }]);
    }
  }
  if (!milestone.verified) {
    return step("delivered", title, [{ kind: "missing", text: "Not verified yet.", fill: "Verify it on Contractors, or link a merged pull request.", seqs: [] }]);
  }
  if (milestone.verification_method === "seed") return step("delivered", title, [{ kind: "inferred", text: "Sample data: marked verified as an example.", seqs: [] }]);
  const by = newest(ctx.own, (entry) => entry.action === "verify_milestone_manual" || (entry.action === "milestone_approval_paid" && entry.detail.heldFor === "unverified"));
  const link = typedLink(milestone.verification_source);
  const note = text(detail.note);
  return step("delivered", title, [
    stated(ctx, `The work was verified by hand${by ? via(by.detail) : ""}.`, by, {
      at: by?.ts ?? milestone.verified_at,
      ...(note ? { notes: [note] } : {}),
      ...(link ? { link: { ...link, label: `The evidence they gave, on ${link.label}` } } : {}),
    }),
  ]);
}

/** 3. The bill: who added it, and from where. */
function billStep(ctx: Context, invoice: EvidenceInvoice): EvidenceStep {
  const title = "The bill";
  const created = oldest(ctx.own, (entry) => CREATION.has(entry.action));
  const currency = invoice.currency ?? "USDC";
  if (!created) {
    if (ctx.input.counterparty?.sample) return step("bill", title, [{ kind: "inferred", text: "Loaded with the sample data; it has no ledger entry of its own.", seqs: [] }]);
    return step("bill", title, [{ kind: "missing", text: "No entry records who added this bill.", fill: "A bill added on Bills & receivables, by email, from a chat or through the API records it.", seqs: [] }]);
  }
  const usdc = typeof created.detail.amount === "number" ? money(created.detail.amount, text(created.detail.currency) ?? currency) : money(invoice.amount, currency);
  if (created.action === "recurring_invoice_created") {
    return step("bill", title, [{ kind: "stated", text: `${usdc}, made on its due day by a recurring payment a person set up.`, who: null, at: created.ts, seqs: [created.seq] }]);
  }
  if (created.action === "import_invoice") return step("bill", title, [stated(ctx, `${usdc}, imported from a CSV file on Bills & receivables.`, created)]);
  // A bill written in the business's own currency in shadow mode (shadow mode S6): the person stated that figure, and
  // code worked out the USDC at a published rate.
  const original = originalBill(created.detail.bill);
  const amount = original ? writtenAmount(original.amount, original.currency) : usdc;
  const document = record(created.detail.document);
  const row = typeof created.detail.importRow === "number" ? created.detail.importRow : null;
  const source = document
    ? `read from ${DOCUMENT_KIND[text(document.kind) ?? ""] ?? "a document"} by ${READER[text(document.reader) ?? ""] ?? "a model"}, then added${via(created.detail) || " on Bills & receivables"} by the person who checked it`
    : created.detail.via === "api"
      ? "sent through the API with a workspace key"
      : created.detail.via === "email"
        ? "arrived by email and added on Bills & receivables"
        : created.detail.via === "import"
          ? `imported with Import a list on Bills & receivables${row !== null ? `, from row ${row} of the list` : ""}`
          : created.detail.via === "xero"
            ? `brought in from Xero${xeroNumber(created.detail)}, and added on Bills & receivables by the person who reviewed it`
          : created.detail.via
            ? `added${via(created.detail)}`
            : "added in the invoice form on Bills & receivables";
  const notes =
    document && text(document.sha256)
      ? [`The document's SHA-256 is ${text(document.sha256)}; the document itself is not kept.`]
      : created.detail.via === "import" && text(created.detail.importFile)
        ? [`The list's SHA-256 is ${text(created.detail.importFile)}; the list itself is not kept.`]
        : [];
  const facts = [stated(ctx, `${amount}, ${source}.`, created, notes.length > 0 ? { notes } : {})];
  if (original) facts.push(conversionFact(original, usdc, created));
  return step("bill", title, facts);
}

/** The bill as it was written and the rate its USDC was worked out at (`create_invoice`'s `bill`); null for any other. */
function originalBill(value: unknown): { currency: string; amount: number; perUsd: number; source: string; at: string } | null {
  const bill = record(value);
  if (!bill) return null;
  const currency = text(bill.currency);
  const source = text(bill.source);
  const at = text(bill.at);
  const { amount, perUsd } = bill;
  if (!currency || !source || !at || typeof amount !== "number" || typeof perUsd !== "number") return null;
  return { currency, amount, perUsd, source, at };
}

/** A bill's own figure as the card shows it: whole when it is whole, else to the cent. */
function writtenAmount(amount: number, currency: string): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/** Where the rates for bills in another currency come from: ExchangeRate-API asks to be named and linked where they are shown. */
const RATES_HOME = "https://www.exchangerate-api.com";

/** Code's conversion of a bill in another currency to the USDC it is paid in: computed, never a person's figure. */
function conversionFact(original: NonNullable<ReturnType<typeof originalBill>>, usdc: string, created: EvidenceEntry): EvidenceFact {
  const base = { kind: "checked" as const, at: created.ts, seqs: [created.seq] };
  if (original.currency === "USD") return { ...base, text: `Converted to ${usdc} at 1 USD = 1 USDC.` };
  const rate = original.perUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    ...base,
    text: `Converted to ${usdc} at ${rate} ${original.currency} to the US dollar, the rate ${original.source} published on ${utcDay(original.at)}.`,
    ...(original.source === "ExchangeRate-API" ? { link: { href: RATES_HOME, label: original.source, state: "checked" as const } } : {}),
  };
}

const DOCUMENT_KIND: Record<string, string> = { pdf: "a PDF", email: "an email", text: "a text file" };
const READER: Record<string, string> = { anthropic: "Claude", deepseek: "DeepSeek", openai: "an OpenAI model", heuristic: "Vestiarion's pattern reader" };

/** 4. The payee: the address paid, who gave and confirmed it, and its screening. */
function payeeStep(ctx: Context): EvidenceStep {
  const facts: EvidenceFact[] = [];
  const view = ctx.payment;
  const address = view.state === "chain" ? view.facts.payee : (ctx.input.payment?.destination ?? ctx.input.counterparty?.address ?? null);
  const own = ctx.input.counterparty?.address ?? null;
  const simulated = view.state === "simulated" && !(own && sameAddress(address, own));
  if (simulated) {
    facts.push({ kind: "inferred", text: "A simulated payee address: nothing was paid on chain.", seqs: [] });
  } else if (!address) {
    facts.push({ kind: "missing", text: "No payment address is on file.", fill: "The payee adds one through a payee link, or a member adds it on Counterparties.", seqs: [] });
  } else {
    const set = ctx.counterparty.find((entry) => SET_ADDRESS.has(entry.action)) ?? null;
    const setTo = set ? (set.action === "create_counterparty" ? set.detail.address : set.detail.to) : null;
    const { addressBy, confirmers } = addressProvenance(address, ctx.counterparty);
    if (addressBy === MIRROR && set) {
      facts.push({ kind: "checked", text: `${short(address)} is a mirror address Vestiarion made for ${ctx.name} in shadow mode: no person typed it.`, at: set.ts, seqs: [set.seq] });
    } else if (addressBy === PAYEE && set) {
      facts.push({
        kind: "stated",
        text: set.detail.via === "github" ? `${short(address)} was given by the payee on GitHub.` : `${short(address)} was sent by the payee through their payee link.`,
        who: "the payee",
        at: set.ts,
        seqs: [set.seq],
      });
    } else if (addressBy && set) {
      facts.push(stated(ctx, `${short(address)} was given${via(set.detail) || " on Counterparties"}.`, set));
    } else if (set && typeof setTo === "string" && !sameAddress(setTo, address)) {
      facts.push({ kind: "contradicted", text: `The address paid, ${short(address)}, is not the one the ledger last recorded for ${ctx.name}.`, at: set.ts, seqs: [set.seq], warn: true });
    } else if (!set && ctx.input.counterparty?.sample) {
      facts.push({ kind: "inferred", text: `${short(address)} was loaded with the sample data; no entry names who gave it.`, seqs: [] });
    } else {
      facts.push({ kind: "missing", text: `No entry names who gave ${short(address)}.`, fill: "A member confirms it on Counterparties.", seqs: set ? [set.seq] : [] });
    }
    if (set && confirmers.length > 0) {
      const confirmations = ctx.counterparty.filter((entry) => entry.action === "counterparty_address_confirmed" && entry.seq > set.seq && sameAddress(entry.detail.address, address));
      for (const entry of [...confirmations].sort((a, b) => a.seq - b.seq)) facts.push(stated(ctx, `The address was confirmed${via(entry.detail) || " on Counterparties"}.`, entry));
    }
  }
  facts.push(screeningFact(ctx));
  for (const entry of [...ctx.counterparty].filter((candidate) => candidate.action === "screening_match_dismissed").sort((a, b) => a.seq - b.seq)) {
    const caption = text(entry.detail.matchedCaption);
    facts.push(stated(ctx, `A screening match was dismissed${caption ? `: not the same person as ${caption}` : ""}.`, entry));
  }
  return step("payee", "The payee", facts);
}

function screeningFact(ctx: Context): EvidenceFact {
  const check = ctx.input.screening;
  if (check) {
    const words = check.risk_level === "clear" ? "clear" : `${check.risk_level} risk`;
    const warn = check.risk_level !== "clear";
    if (check.screening_mode === "live" && check.source.startsWith("opensanctions")) {
      return { kind: "verified", text: `${ctx.name} was screened ${words} by OpenSanctions.`, at: check.created_at, seqs: [], ...(warn ? { warn } : {}) };
    }
    return { kind: "checked", text: `${ctx.name} was screened ${words} against the bundled list, not a screening service.`, at: check.created_at, seqs: [], ...(warn ? { warn } : {}) };
  }
  const recorded = text(record(ctx.decision?.detail.observed)?.riskLevel);
  if (recorded && recorded !== "unscreened" && ctx.decision) {
    return { kind: "inferred", text: `${ctx.name} was ${recorded === "clear" ? "clear" : `${recorded} risk`} as the agent's decision recorded; no screening check is on file.`, at: ctx.decision.ts, seqs: [ctx.decision.seq] };
  }
  return {
    kind: "missing",
    text: ctx.paid ? `${ctx.name} was not screened before it was paid.` : `${ctx.name} is not screened yet.`,
    fill: "Vestiarion screens each counterparty every cycle; Compliance shows the result.",
    seqs: [],
  };
}

const MILESTONE_VERBS: Record<string, string> = { milestone_release: "to release it", milestone_hold: "to hold it for a person" };

/** 5. The decision: who decided, and what code checked before anything was sent. The trail has the steps. */
function decisionStep(ctx: Context): EvidenceStep {
  // A payable's trail exists once an entry is about it; a milestone has none.
  const trail = ctx.key === "invoiceId" && ctx.own.length > 0 ? { invoiceId: ctx.id } : null;
  const decision = ctx.decision;
  if (!decision) {
    return step(
      "decision",
      "The decision",
      [
        ctx.paid
          ? { kind: "missing", text: "No decision of the agent's is recorded.", fill: "Sample data, and bills paid before Vestiarion decided them, have none.", seqs: [] }
          : { kind: "missing", text: "The agent has not decided it yet.", fill: "The agent decides it in its next cycle, usually within a minute.", seqs: [] },
      ],
      { trail }
    );
  }
  const decider = deciderName(decision.detail.decisionMode);
  const policy = decider === "The written policy";
  const agreed = policy ? "" : decision.detail.agreedWithReference === true ? ", as the written policy would" : decision.detail.agreedWithReference === false ? "; the written policy would have decided otherwise" : "";
  const sentence =
    ctx.key === "invoiceId"
      ? (trailStep(decision, ctx.input.network)?.text ?? `${decider} decided.`)
      : `${decider} decided ${MILESTONE_VERBS[decision.action] ?? "on it"}${agreed}.`;
  const paying = PAYING.has(decision.action);
  const checks = decisionChecks(decision.detail, paying);
  const verification = record(record(decision.detail.observed)?.verification);
  const notes = [...(verification ? [verification.verified === true ? "✓ The work verified" : "✗ The work not verified"] : []), ...checks.notes];
  const facts: EvidenceFact[] = [
    {
      kind: policy ? "checked" : "inferred",
      text: sentence,
      at: decision.ts,
      seqs: [decision.seq],
      notes: policy ? ["No model answered: the written policy is code."] : ["The model's judgement, from the facts it was given."],
    },
    {
      kind: "checked",
      text: checks.refused ? "Code refused it before anything was sent." : notes.length > 0 ? "Code checked it before anything was sent." : "Code's guardrails let it through.",
      at: decision.ts,
      seqs: [decision.seq],
      notes,
      ...(checks.refused ? { warn: true } : {}),
    },
  ];
  return step("decision", "The decision", facts, { trail });
}

/** 6. People: approvals, verdicts, returns and rejections. */
function peopleStep(ctx: Context): EvidenceStep {
  const verdicts = ctx.input.entries.filter((entry) => entry.action === "decision_verdict" && entry.detail.subjectId === ctx.id);
  const acts = [...ctx.own, ...verdicts].filter((entry) => PEOPLE_WORDS[entry.action]).sort((a, b) => a.seq - b.seq);
  const facts = acts.map((entry) => {
    const approvals = Array.isArray(entry.detail.approvals) ? (entry.detail.approvals as unknown[]).map(record).filter((approval) => approval !== null) : [];
    const reason = text(entry.detail.reason);
    const notes = [
      ...approvals.map((approval) => `Approved by ${ctx.who(approval.by) ?? "someone"}${text(approval.at) ? ` on ${utcMinute(approval.at as string)}` : ""}`),
      ...(reason ? [`Reason: ${reason}`] : []),
    ];
    const words = PEOPLE_WORDS[entry.action](entry.detail, ctx.networkLabel);
    // Where it was done is said of the person's act, before what became of the payment.
    return stated(ctx, `${words.act}${via(entry.detail)}${words.then ?? ""}.`, entry, notes.length > 0 ? { notes } : {});
  });
  if (facts.length > 0) return step("people", "People", facts);
  if (ctx.paid && ctx.decision && PAYING.has(ctx.decision.action)) {
    return step("people", "People", [{ kind: "checked", text: "No person approved it: code let the agent pay it within the workspace's rules.", seqs: [ctx.decision.seq] }]);
  }
  if (!ctx.paid && !ctx.closed) return step("people", "People", [{ kind: "missing", text: "No person has decided it yet.", fill: "When the agent holds it, a person decides it in Approvals.", seqs: [] }]);
  return step("people", "People", [{ kind: "missing", text: "No person's approval is recorded.", seqs: [] }]);
}

/** What a person did, and, for an approval that pays, what became of the payment then. */
type PeopleWords = { act: string; then?: string };

/**
 * A person's Approve and pay, or Pay now, by what its transfer did then (the entry's `status`): paid only once it
 * confirmed; sent, while the network confirms it (`matched`, `verified` for a milestone); held again, never "failed",
 * since Gateway's reported failure or a failed read may still settle (settlement lifecycle L3, L9).
 */
function approvedWords(detail: Record<string, unknown>, network: string, sent: "matched" | "verified", own: string): PeopleWords {
  if (detail.status === "paid") return { act: `Approved and paid it${own}` };
  if (detail.status === sent) return { act: `Approved it${own}`, then: `; ${PAYMENT_SENT(network)}` };
  if (detail.status === "held") return { act: `Approved it${own}`, then: `; ${PAYMENT_HELD_AGAIN}` };
  return { act: `Approved paying it${own}` };
}

const PEOPLE_WORDS: Record<string, (detail: Record<string, unknown>, network: string) => PeopleWords> = {
  approval_given: () => ({ act: "Gave the first of two approvals" }),
  approval_paid: (detail, network) => approvedWords(detail, network, "matched", detail.soleApprover === true ? ", as the workspace's only approver" : ""),
  approval_returned: () => ({ act: "Returned it to the agent" }),
  approval_rejected: () => ({ act: "Rejected it" }),
  milestone_approval_given: () => ({ act: "Gave the first of two approvals" }),
  milestone_approval_paid: (detail, network) => approvedWords(detail, network, "verified", " with Pay now"),
  milestone_closed: () => ({ act: "Closed it without paying it" }),
  decision_verdict: (detail) => ({ act: detail.verdict === "agree" ? "Agreed with the agent's decision" : "Disagreed with the agent's decision" }),
};

/** 7. The payment: the transaction, Arc's own record of it, and the entry that records it. */
function paymentStep(ctx: Context, onChain: OnChainCheck | null): EvidenceStep {
  const title = "The payment";
  const view = ctx.payment;
  const live = `A live workspace pays on ${ctx.networkLabel}.`;
  switch (view.state) {
    case "chain": {
      const { facts } = view;
      const chain = chainById(facts.chain);
      const route = facts.route === "cctp" ? `, through CCTP from ${homeChain(networkOf(ctx.input.payment?.network)).label}` : facts.route === "gateway" ? ", from a Circle Gateway balance" : "";
      const sentence = `Paid ${money(facts.amount, facts.token)} to ${short(facts.payee)} on ${chain.label}${route}.`;
      const href = `${chain.explorerTx}${facts.txHash}`;
      const shadow = ctx.decision?.detail.shadow === true || ctx.input.entries.some((entry) => entry.action === "decision_verdict" && entry.detail.subjectId === ctx.id);
      const shadowNote = shadow ? [`Made in shadow mode on ${chain.label}: it mirrors a bill the business paid its own way.`] : [];
      const read =
        onChain?.state === "matches"
          ? { kind: "verified" as const, link: "checked" as const, note: `Block ${onChain.block} on ${chain.label} holds a transfer of ${money(facts.amount, facts.token)} to the payee in this transaction.` }
          : onChain?.state === "mismatch"
            ? { kind: "contradicted" as const, link: "contradicted" as const, note: onChain.reason }
            : { kind: "unreachable" as const, link: "unreachable" as const, note: `${chain.label} did not answer just now. The explorer shows the transaction.` };
      return step("payment", title, [
        {
          kind: read.kind,
          text: sentence,
          at: facts.paidAt || null,
          notes: [read.note, ...shadowNote],
          seqs: [],
          link: { href, label: "The transaction", state: read.link },
          ...(read.kind === "contradicted" ? { warn: true } : {}),
        },
        ...discountFacts(ctx, view.recording),
        recordingFact(view.recording),
      ]);
    }
    case "recorded":
      return step("payment", title, [
        {
          kind: "inferred",
          text: `Transaction ${short(view.txHash)} is on the record, but no payment Vestiarion made names it.`,
          seqs: [],
          link: { href: `${homeChain(ctx.input.network).explorerTx}${view.txHash}`, label: "The transaction", state: "not_opened" },
        },
        ...discountFacts(ctx, view.recording),
        recordingFact(view.recording),
      ]);
    case "simulated":
      return step("payment", title, [{ kind: "missing", text: "Simulated: nothing moved on chain.", fill: live, seqs: [] }, ...discountFacts(ctx, null)]);
    case "in_flight":
      return step("payment", title, [{ kind: "missing", text: "Sent, not confirmed yet.", fill: "The agent confirms it with Circle, usually within a minute.", seqs: [] }]);
    case "failed":
      return step("payment", title, [{ kind: "missing", text: "The transfer failed.", fill: "Approvals shows what to do next.", seqs: [], warn: true }]);
    case "unready":
      return step("payment", title, [{ kind: "missing", text: view.reason || "This payment has no transaction on chain to show.", seqs: [] }]);
    case "no_record":
      return step("payment", title, [{ kind: "missing", text: "Marked paid, with no payment recorded.", fill: "Sample data and history imported as paid carry none.", seqs: [] }]);
    default:
      if (ctx.closed) {
        return step("payment", title, [{ kind: "missing", text: ctx.key === "invoiceId" ? "Not paid: a person rejected it." : "Not paid: a person closed it without paying it.", seqs: [] }]);
      }
      return step("payment", title, [{ kind: "missing", text: "Not paid yet.", fill: `Paid on ${ctx.networkLabel} when the agent or a person pays it.`, seqs: [] }]);
  }
}

/**
 * What the early-payment discount took off a bill paid early (payment timing, 0038): the entry that recorded it, the
 * payment's own or the newest that did; read from the bill's record alone when no entry did. None for a bill paid whole.
 */
function discountFacts(ctx: Context, recording: EvidenceEntry | null): EvidenceFact[] {
  const { paidAmount, amount, currency } = ctx;
  if (paidAmount === null) return [];
  const discount = Math.round((amount - paidAmount) * 1e6) / 1e6;
  const records = (entry: EvidenceEntry) => RECORDING_ACTIONS.has(entry.action) && typeof entry.detail.discountTaken === "number" && entry.detail.discountTaken > 0;
  const recorded = recording && records(recording) ? recording : newest(ctx.own, records);
  if (!recorded) {
    return [{ kind: "inferred", text: `The bill's record says ${money(paidAmount, currency)} was paid, ${money(discount, currency)} less than the bill; no entry records the early-payment discount.`, seqs: [] }];
  }
  return [
    {
      kind: "checked",
      text: `The early-payment discount took ${money(discount, currency)} off the ${money(amount, currency)} bill, so ${money(paidAmount, currency)} was paid.`,
      at: recorded.ts,
      seqs: [recorded.seq],
    },
  ];
}

function recordingFact(recording: EvidenceEntry | null): EvidenceFact {
  return recording
    ? { kind: "checked", text: `Entry ${pad(recording.seq)} records this transaction.`, at: recording.ts, seqs: [recording.seq] }
    : { kind: "missing", text: "No ledger entry records this transaction.", seqs: [] };
}

/**
 * 7b. The books (accounting write-back W10): the payment booked in the accounting tool it came from, as the tool stated
 * it when Vestiarion read it back. Only for a payable brought in from one whose payment was drafted for booking; the
 * page never opens the tool again, so a booking read back is labelled by that read.
 */
function booksStep(ctx: Context): EvidenceStep | null {
  if (ctx.key !== "invoiceId") return null;
  const mark = bookingFromEntries(ctx.own, ctx.id);
  if (!mark) return null;
  const title = "The books";
  const label = mark.label;
  const approved = mark.approvedSeq !== null ? [mark.approvedSeq] : [];
  const seqs = [...new Set([...approved, mark.seq])];
  const amount = mark.amount && mark.currency ? ` of ${AMOUNT.format(Number(mark.amount))} ${mark.currency}` : "";
  const by = mark.approvedBy ? ctx.who(mark.approvedBy) : null;
  const approvedNote = by ? [`Approved by ${by} before it was sent.`] : [];
  switch (mark.state) {
    case "confirmed":
      return step("books", title, [
        {
          kind: "verified",
          text: `Booked in ${label} as payment ${mark.paymentId ?? ""}${amount}${mark.account ? ` from ${mark.account}` : ""}: stated by ${label} when Vestiarion read it back.`.replace("payment :", "payment:"),
          at: mark.at,
          notes: [...approvedNote, `The Arc transaction is its reference in ${label}. This page does not open ${label} again.`],
          seqs,
        },
      ]);
    case "sent":
    case "approved":
      return step("books", title, [
        {
          kind: "unreachable",
          text: mark.state === "sent" ? `Sent to ${label}${mark.paymentId ? ` as payment ${mark.paymentId}` : ""}, not read back yet.` : `Approved to be booked in ${label}; ${label} has not answered yet.`,
          at: mark.at,
          notes: [...approvedNote, "Vestiarion reads it back at the next sync."],
          seqs,
        },
      ]);
    case "drafted":
      return step("books", title, [
        { kind: "missing", text: `Not booked in ${label} yet.`, fill: `An owner or admin reviews it under To book in ${label} on Bills & receivables, then approves it.`, seqs },
      ]);
    case "failed":
      return step("books", title, [
        { kind: "missing", text: mark.message ?? `Not booked in ${label} yet.`, fill: `Approve it again under To book in ${label} on Bills & receivables.`, at: mark.at, seqs },
      ]);
    case "refused": {
      // The reality rule and a currency are Vestiarion's own checks; a bill paid, closed or a payment deleted is what the tool said.
      const ours = mark.reason === "reality" || mark.reason === "currency";
      return step("books", title, [{ kind: ours ? "checked" : "verified", text: mark.message ?? `Not booked in ${label}.`, at: mark.at, seqs }]);
    }
  }
}

/** 8. The receipt: shared or not, its signed entry, and whether its link still opens. */
function receiptStep(ctx: Context): EvidenceStep {
  const title = "The receipt";
  const receipt = ctx.input.receipt;
  const view = ctx.payment;
  const recording = view.state === "chain" ? view.recording : null;
  if (!receipt) {
    if (view.state === "chain" && ctx.paid) return step("receipt", title, [{ kind: "missing", text: "Not shared.", fill: "An owner or admin shares it with Share receipt on Bills & receivables.", seqs: [] }]);
    const why =
      view.state === "simulated"
        ? "A simulated payment has nothing on chain to show."
        : ctx.paid
          ? "A receipt needs a transaction on chain."
          : ctx.closed
            ? "A receipt is made only for a payment on chain."
            : "A receipt is made once it is paid.";
    return step("receipt", title, [{ kind: "missing", text: "No receipt.", fill: why, seqs: [] }]);
  }
  const shared = ctx.input.entries.find((entry) => entry.seq === receipt.entry_seq && entry.action === "receipt_shared") ?? null;
  const base = { who: ctx.who(receipt.created_by), at: receipt.created_at };
  if (receipt.revoked_at) {
    const revoked = newest(ctx.input.entries, (entry) => entry.action === "receipt_revoked" && entry.detail.receiptId === receipt.id);
    return step("receipt", title, [
      { kind: "unreachable", text: "Shared, then its link was revoked: it no longer opens.", ...base, notes: [`Revoked on ${utcMinute(receipt.revoked_at)}.`], seqs: [receipt.entry_seq, ...(revoked ? [revoked.seq] : [])] },
    ]);
  }
  if (!shared) return step("receipt", title, [{ kind: "contradicted", text: "The receipt's entry is not in the ledger.", ...base, seqs: [receipt.entry_seq], warn: true }]);
  const check = ctx.input.checks.entries.get(shared.seq);
  if (check?.ok === false) return step("receipt", title, [{ kind: "contradicted", text: `The receipt's entry does not verify: ${check.reason}`, ...base, seqs: [shared.seq], warn: true }]);
  if (!check || check.ok === null) return step("receipt", title, [{ kind: "unreachable", text: `The receipt's entry could not be checked here${check ? `: ${check.reason}` : "."}`, ...base, seqs: [shared.seq] }]);
  // As the public receipt page checks it (payment receipts P5, `recordsTransaction`): the entry it names, by seq and by
  // hash, written before it, records a payment of this transaction — the payee's, or a CCTP payout's burn on Arc, which
  // is all a person's Approve and pay records when the mint lands within the provider's wait.
  const names = record(shared.detail.records);
  const named = ctx.own.find((entry) => entry.seq === names?.seq) ?? null;
  const transactions = view.state === "chain" ? [view.facts.txHash, ...(view.facts.sourceTxHash ? [view.facts.sourceTxHash] : [])] : [];
  const records =
    named !== null &&
    transactions.length > 0 &&
    typeof names?.hash === "string" &&
    named.seq < shared.seq &&
    RECORDING_ACTIONS.has(named.action) &&
    recordsTransaction(named, names.hash, transactions);
  if (!records) return step("receipt", title, [{ kind: "contradicted", text: "The receipt names an entry that does not record this transaction.", ...base, seqs: [shared.seq], warn: true }]);
  return step("receipt", title, [
    {
      kind: "checked",
      text: `Shared. Its signed entry verifies and names entry ${pad(named.seq)}, which records this transaction.`,
      ...base,
      notes: ["Its link was shown once, to the person who shared it, and opens a public page anyone can check.", ...(recording && recording.seq !== named.seq ? [`A later entry, ${pad(recording.seq)}, records it too.`] : [])],
      seqs: [shared.seq, named.seq],
    },
  ]);
}

/** 9. Signatures: every entry the chain rests on, checked here and again in the reader's browser. */
function signaturesStep(rows: Array<EvidenceEntry & { check: EntryCheck }>): EvidenceStep {
  const title = "Signatures";
  if (rows.length === 0) {
    return step("signatures", title, [{ kind: "missing", text: "No ledger entry is about this record.", fill: "Records loaded as sample data have none.", seqs: [] }], { caveat: SIGNED_ENTRY_PROVES });
  }
  const facts: EvidenceFact[] = [];
  const good = rows.filter((row) => row.check.ok === true);
  if (good.length > 0) {
    facts.push({
      kind: "checked",
      text: `${good.length === 1 ? "1 entry verifies: it is" : `${good.length} entries verify: each is`} signed with the workspace's key, and its hash follows from its content, its signature and the hash before it.`,
      notes: ["The Audit log checks the whole chain, entry after entry."],
      seqs: good.map((row) => row.seq),
    });
  }
  for (const row of rows) {
    if (row.check.ok === false) facts.push({ kind: "contradicted", text: `Entry ${pad(row.seq)} does not verify: ${row.check.reason}`, seqs: [row.seq], warn: true });
    else if (row.check.ok === null) facts.push({ kind: "unreachable", text: `Entry ${pad(row.seq)} could not be checked here: ${row.check.reason}`, seqs: [row.seq] });
  }
  return step("signatures", title, facts, { caveat: SIGNED_ENTRY_PROVES });
}

const NOT_CHECKED: EntryCheck = { ok: null, reason: "It was not checked." };

/** The record the chain is about, as one shape for either kind. */
function subjectOf(input: Pick<EvidenceInput, "subject">) {
  const invoice = input.subject.kind === "invoice" ? input.subject.invoice : null;
  const milestone = input.subject.kind === "milestone" ? input.subject.milestone : null;
  const row = (invoice ?? milestone) as EvidenceInvoice | EvidenceMilestone;
  const key = invoice ? ("invoiceId" as const) : ("milestoneId" as const);
  const ref = invoice ? { invoiceId: row.id } : { milestoneId: row.id };
  return { invoice, milestone, row, key, ref };
}

export interface ChainAnchors {
  /** The entry that records the payment's transaction, when there is one. */
  recording: EvidenceEntry | null;
  /** The agent's decision the chain rests on: the one that paid it, or its newest before the payment, or its newest of all while open. */
  decision: EvidenceEntry | null;
  /** When the payee's screening is read for (E5): the decision's time, else the payment's; null for now. */
  at: string | null;
}

/**
 * The decision the chain rests on and the entry that records the payment (E5). The builder words the chain from them;
 * the reader asks for the screening check at their time, so a workspace that screens every cycle is read once.
 */
export function chainAnchors(input: Pick<EvidenceInput, "subject" | "entries" | "payment" | "network">): ChainAnchors {
  const { row, key, ref } = subjectOf(input);
  const own = input.entries.filter((entry) => entry.detail[key] === row.id).sort((a, b) => a.seq - b.seq);
  const payment = paymentView(input, own, row.status, row.tx_ref, ref);
  return anchorsOf(own, payment);
}

function anchorsOf(own: EvidenceEntry[], payment: PaymentView): ChainAnchors {
  const recording = payment.state === "chain" || payment.state === "recorded" ? payment.recording : null;
  const cutoff = recording?.seq ?? Number.POSITIVE_INFINITY;
  const decision = recording && isAgentDecision(recording) ? recording : newest(own, (entry) => isAgentDecision(entry) && entry.seq < cutoff);
  return { recording, decision, at: decision?.ts ?? recording?.ts ?? null };
}

/** Rejected by a person, or closed without paying: it will not be paid. */
const CLOSED = new Set(["rejected", "closed"]);

/** What a paid bill's transfer carried (`paid_amount`), when the early-payment discount made it less than the bill. */
function discountedPaid(invoice: EvidenceInvoice): number | null {
  const paid = invoice.paid_amount;
  if (invoice.status !== "paid" || typeof paid !== "number" || !Number.isFinite(paid) || paid < 0 || paid >= invoice.amount) return null;
  return paid;
}

export function buildEvidenceChain(input: EvidenceInput): EvidenceChain {
  const { invoice, milestone, row, key, ref } = subjectOf(input);
  const { id, status } = row;
  const own = input.entries.filter((entry) => entry.detail[key] === id).sort((a, b) => a.seq - b.seq);
  const payment = paymentView(input, own, status, row.tx_ref, ref);
  const { recording, decision } = anchorsOf(own, payment);
  const cutoff = recording?.seq ?? Number.POSITIVE_INFINITY;
  const counterpartyId = input.counterparty?.id ?? null;
  const people = input.people;
  const currency = invoice ? (invoice.currency ?? "USDC") : "USDC";
  const ctx: Context = {
    input,
    key,
    id,
    name: input.counterparty?.name ?? "The payee",
    paid: status === "paid",
    closed: CLOSED.has(status),
    amount: row.amount,
    currency,
    paidAmount: invoice ? discountedPaid(invoice) : null,
    own,
    counterparty: input.entries
      .filter((entry) => counterpartyId !== null && entry.domain === "compliance" && entry.detail.counterpartyId === counterpartyId && entry.seq <= cutoff)
      .sort((a, b) => b.seq - a.seq),
    payment,
    decision,
    // By email (E8); "a member" when the members could not be read, never a guess that they left.
    who: (user) => (typeof user === "string" && user.length > 0 ? (people === null ? "a member" : (people.get(user) ?? "a former member")) : null),
    networkLabel: networkProfile(input.network).label,
  };

  const steps: EvidenceStep[] = invoice
    ? [
        agreedInvoice(ctx, invoice),
        deliveredInvoice(ctx, invoice),
        billStep(ctx, invoice),
        payeeStep(ctx),
        decisionStep(ctx),
        peopleStep(ctx),
        paymentStep(ctx, input.checks.onChain),
        ...[booksStep(ctx)].filter((one): one is EvidenceStep => one !== null),
        receiptStep(ctx),
      ]
    : [agreedMilestone(ctx, milestone!), deliveredMilestone(ctx, milestone!), payeeStep(ctx), decisionStep(ctx), peopleStep(ctx), paymentStep(ctx, input.checks.onChain)];
  // Every entry about the record, and every other entry a fact rests on.
  const cited = new Set(steps.flatMap((s) => s.facts.flatMap((fact) => fact.seqs)));
  const rows = input.entries
    .filter((entry) => entry.detail[key] === id || cited.has(entry.seq))
    .filter((entry, index, all) => all.findIndex((other) => other.seq === entry.seq) === index)
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => ({ ...entry, check: input.checks.entries.get(entry.seq) ?? NOT_CHECKED }));
  steps.push(signaturesStep(rows));

  const tally = Object.fromEntries(EVIDENCE_ORDER.map((kind) => [kind, 0])) as Record<EvidenceKind, number>;
  for (const fact of steps.flatMap((s) => s.facts)) tally[fact.kind] += 1;

  return {
    subject: {
      kind: input.subject.kind,
      id,
      title: invoice ? (invoice.memo ?? "A bill") : milestone!.title,
      payee: ctx.name,
      amount: row.amount,
      paidAmount: ctx.paidAmount,
      currency,
      status,
      paid: ctx.paid,
      closed: ctx.closed,
      simulated: ctx.paid && payment.state === "simulated",
      onChain: ctx.paid && payment.state === "chain",
    },
    network: input.network,
    steps,
    tally,
    entries: rows,
  };
}

