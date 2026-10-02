import { committedState } from "@/lib/agent/duplicates";
import { invoiceDiscount } from "@/lib/agent/payment-timing";
import { utcDay } from "@/lib/copy";
import { explainMilestone, explainPayable, explainTreasury, presentReasoning } from "@/lib/reasoning-copy";
import type { LedgerEntry } from "@/lib/ledger";
import type { CounterpartyRow, InvoiceRow, MilestoneRow, TreasuryActionRow } from "@/lib/queries";
import type { Decision, Evidence, Guardrail, Outcome } from "./types";
import { fmt } from "./Primitives";
import { BRIDGE_FEE_CAP_PERCENT, paidAcrossChains, payeeChain } from "@/lib/payee-chains";
import { SWAP_COST_CAP_PERCENT } from "@/lib/fx/swap-limits";

/**
 * Renders the duplicate-billing check as evidence in its own right — including
 * when it found nothing. "Checked 8 earlier invoices, no repeat" is the half of
 * a fraud control that a display which only shows hits can never prove, and it
 * is the half a reviewer needs in order to trust the other one.
 *
 * Returns null only for invoices decided before the check existed, where
 * claiming either result would be an invention.
 */
function duplicateEvidence(observed: Record<string, unknown> | undefined): Evidence | null {
  const check = record(observed?.duplicateCheck);
  if (!check) return null;

  const matches = Array.isArray(check.matches) ? check.matches : [];
  const considered = numberValue(check.candidatesConsidered) ?? 0;
  if (matches.length === 0) {
    return {
      label: "Duplicate check",
      value: `clear against ${considered} earlier invoice${considered === 1 ? "" : "s"}`,
      state: "ok",
    };
  }

  const strongest = record(matches[0]);
  const confidence = numberValue(strongest?.confidence);
  // Worded as the match's own explanation words it (./duplicates.ts): already
  // paid, being paid, scheduled or being decided by a person.
  const committed = committedState(stringValue(strongest?.otherInvoiceStatus) ?? "");
  return {
    label: "Duplicate check",
    value: `${matches.length} match${matches.length === 1 ? "" : "es"}${
      confidence == null ? "" : ` at ${(confidence * 100).toFixed(0)}%`
    }${committed ? ` against an invoice ${committed}` : ""}`,
    state: "missing",
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The newest entry about the record that decided or recorded it: a receipt's entries are about sharing, not deciding (receipts review #1). */
function matchingEntry(entries: LedgerEntry[], key: "invoiceId" | "milestoneId", id: string) {
  return entries.find((entry) => entry.detail[key] === id && !entry.action.startsWith("receipt_"));
}

/**
 * The invoice's payment terms, as a fact a person reads next to the decision
 * — not only in the agent's reasoning — when it carries an early-payment
 * discount (payment timing design §1, "What a person sees").
 */
function termsEvidence(invoice: InvoiceRow): Evidence | null {
  const discount = invoiceDiscount(invoice);
  if (!discount) return null;
  return { label: "Terms", value: `${discount.pct}% off if paid by ${utcDay(discount.deadline)}`, state: "neutral" };
}

/**
 * What actually left, when it paid less than the invoice's full amount — an
 * early-payment discount taken. `invoice.amount` is never reduced, so this is
 * the only place the discounted transfer is shown next to the decision.
 */
/**
 * The swap of USDC for EURC that funded a EURC payment, linked to its transaction on Arc testnet, or a
 * swap that failed or is still in flight (EURC swap spec S9). Null when no swap was made.
 */
function swapEvidence(detail: Record<string, unknown> | undefined): Evidence | null {
  const swap = record(detail?.swap);
  const state = stringValue(swap?.state);
  if (state === "confirmed") {
    const hash = stringValue(swap?.swapTxHash);
    const received = numberValue(swap?.eurcReceived);
    return {
      label: "Funded by swap",
      value: `${numberValue(swap?.usdcIn)} USDC → ${received ?? "?"} EURC`,
      ...(hash ? { href: `${payeeChain("ARC-TESTNET").explorerTx}${hash}` } : {}),
      state: "ok",
    };
  }
  if (state === "failed") return { label: "Swap", value: "failed", state: "missing" };
  if (state === "pending") return { label: "Swap", value: "in flight", state: "neutral" };
  return null;
}

function paidEvidence(invoice: InvoiceRow): Evidence | null {
  if (invoice.status !== "paid" || invoice.paid_amount == null || invoice.paid_amount >= invoice.amount) return null;
  const pct = invoice.early_pay_discount_pct == null ? null : Number(invoice.early_pay_discount_pct);
  const note = pct != null && Number.isFinite(pct) ? ` (${pct}% discount)` : "";
  return { label: "Paid", value: `${fmt(invoice.paid_amount)} ${invoice.currency ?? "USDC"}${note}`, state: "ok" };
}

/**
 * What the outcome badge says for an invoice whose outcome word alone would
 * mislead: only a scheduled invoice reads "Scheduled", with its day. A
 * pending one has not been decided yet, a matched one has a transfer in
 * flight, and a processing one is with a person on Approvals, though all
 * three share the neutral outcome.
 */
function invoiceOutcomeLabel(invoice: InvoiceRow, guardrailBlocked: boolean): string | undefined {
  switch (invoice.status) {
    case "awaiting_info":
      return "Awaiting info";
    case "flagged":
      return guardrailBlocked ? undefined : "Flagged for review";
    case "scheduled":
      return invoice.scheduled_for ? `Scheduled for ${utcDay(invoice.scheduled_for)}` : undefined;
    case "pending":
      // The agent decides payables, never receivables — a receivable just
      // waits on the counterparty to pay it.
      return invoice.direction === "receivable" ? "Awaiting payment" : "Not yet decided";
    case "matched":
      return "Payment in flight";
    case "processing":
      return "Being decided by a person";
    case "paid":
      // A recognised tx_ref already reads as paid through its own outcome
      // word ("Settled on Arc" / "Simulated"); an unrecognised or missing one
      // — sample history, or a row from before tx_ref was recorded — must
      // still read as paid, never fall through to the default "Scheduled".
      return invoice.tx_ref?.startsWith("0x") || invoice.tx_ref?.startsWith("sim_") ? undefined : "Paid";
    default:
      return undefined;
  }
}

function statusOutcome(status: string, txRef: string | null, guardrailBlocked: boolean): Outcome {
  if (guardrailBlocked) return "refused";
  if (status === "paid" && txRef?.startsWith("0x")) return "settled";
  if (status === "paid" && txRef?.startsWith("sim_")) return "simulated";
  // A paid invoice whose tx_ref is missing or unrecognised must never fall
  // through to the default "scheduled" outcome below — that reads as
  // "Scheduled", which a paid invoice never is (spec §1, "never Scheduled
  // otherwise").
  if (status === "paid") return "recorded";
  if (["held", "flagged", "awaiting_info"].includes(status)) return "held";
  if (["received", "rejected"].includes(status)) return "recorded";
  return "scheduled";
}

const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

/**
 * A receivable's card (receivables on Arc): money a client owes the business. It shows none of a payable's
 * facts (purchase order, goods received, payment limit, the payee's chain); while open it waits on the
 * client, and once a transfer settled it, it says who sent it and how the agent matched it, from the signed
 * `ar_received` entry, with the transaction.
 */
function receivableDecision(invoice: InvoiceRow, entries: LedgerEntry[]): Decision {
  const received = entries.find((entry) => entry.action === "ar_received" && entry.detail.invoiceId === invoice.id);
  const detail = received?.detail;
  const currency = invoice.currency ?? "USDC";
  const from = stringValue(detail?.from);
  const matchedBy = stringValue(detail?.matchedBy);
  const onArc = invoice.tx_ref?.startsWith("0x") ?? false;
  const settled = invoice.status === "received" || invoice.status === "paid";

  const reasoning = received
    ? `Received ${fmt(numberValue(detail?.amount) ?? invoice.amount)} ${stringValue(detail?.currency) ?? currency}${from ? ` from ${shortAddress(from)}` : ""} on Arc testnet` +
      `${stringValue(detail?.receivedAt) ? ` on ${utcDay(stringValue(detail?.receivedAt) as string)}` : ""}, and matched it to this invoice: ` +
      (matchedBy === "sender"
        ? `it came from ${invoice.counterparty_name}'s address on file.`
        : `it is the only open receivable of that amount, and ${invoice.counterparty_name} was sent its pay link.`)
    : settled
      ? presentReasoning(invoice.agent_reasoning) || `Marked received.`
      : invoice.status === "rejected"
        ? presentReasoning(invoice.agent_reasoning) || "Rejected."
        : `Waiting for ${invoice.counterparty_name} to pay. When the exact amount arrives in the operating wallet on Arc testnet, the agent matches it to this invoice.`;

  const evidence: Evidence[] = [{ label: "Due", value: new Date(invoice.due_date).toLocaleDateString("en-US"), state: "neutral" }];
  if (from) evidence.push({ label: "Received from", value: shortAddress(from), state: "ok" });
  if (matchedBy) evidence.push({ label: "Matched by", value: matchedBy === "sender" ? "the client's address" : "amount, through the pay link", state: "ok" });

  return {
    id: invoice.id,
    domain: "ar",
    action: "Collect from",
    subject: invoice.counterparty_name,
    memo: invoice.memo ?? undefined,
    amount: invoice.amount,
    token: currency,
    outcome: settled && onArc ? "settled" : statusOutcome(invoice.status, invoice.tx_ref, false),
    outcomeLabel: settled ? (onArc ? "Received on Arc" : "Received") : invoiceOutcomeLabel(invoice, false),
    reasoning,
    evidence,
    guardrail: null,
    decisionMode: undefined,
    txHash: onArc ? invoice.tx_ref : null,
    mint: null,
    auditSeq: received?.seq,
    at: received?.ts ?? invoice.due_date,
  };
}

export function invoiceDecision(invoice: InvoiceRow, counterparty: CounterpartyRow | undefined, entries: LedgerEntry[]): Decision {
  if (invoice.direction === "receivable") return receivableDecision(invoice, entries);
  const entry = matchingEntry(entries, "invoiceId", invoice.id);
  const observed = record(entry?.detail.observed);
  // The agent's own decision, with the facts it was made on: what its reasoning is explained from.
  const decided = entries.find((candidate) => candidate.detail.invoiceId === invoice.id && record(candidate.detail.observed) !== undefined);
  const guardrailBlocked = entry?.detail.guardrailBlocked === true;
  const limit = numberValue(observed?.paymentLimit) ?? counterparty?.payment_limit ?? 0;
  const risk = stringValue(observed?.riskLevel) ?? counterparty?.risk_level ?? "unscreened";
  const outcome = statusOutcome(invoice.status, invoice.tx_ref, guardrailBlocked);
  const rule = risk === "high" ? "counterparty.high_risk" : "counterparty.payment_limit";
  // A EURC invoice is shown in EURC and weighed at the USDC value its decision
  // recorded (EURC invoices design E2, E6); the limit is always USDC.
  const currency = invoice.currency ?? "USDC";
  const eurc = currency === "EURC";
  const usdcValue = eurc ? (numberValue(entry?.detail.usdcValue) ?? null) : invoice.amount;
  const rate = numberValue(record(entry?.detail.fx)?.rate);
  const route = routeOf(invoice.id, entries);
  const routeFees = routeFeesOf(invoice.id, entries);
  const mint = mintOf(invoice.id, entries);
  // A payout to another chain settles on that chain, not on Arc: named from its recorded mint, or
  // from the payee's chain for one recorded before mints were.
  const settledOn = outcome !== "settled" ? null : mint ? mint.chainLabel : paidAcrossChains(counterparty?.chain) ? payeeChain(counterparty?.chain).label : null;

  return {
    id: invoice.id,
    domain: invoice.direction === "receivable" ? "ar" : "ap",
    action: invoice.direction === "receivable" ? "Collect from" : "Pay",
    subject: invoice.counterparty_name,
    memo: invoice.memo ?? undefined,
    amount: invoice.amount,
    token: currency,
    outcome,
    outcomeLabel: settledOn ? `Settled on ${settledOn}` : invoiceOutcomeLabel(invoice, guardrailBlocked),
    reasoning:
      presentReasoning(
        invoice.agent_reasoning,
        explainPayable({
          name: invoice.counterparty_name,
          amount: invoice.amount,
          currency,
          dueDate: invoice.due_date,
          poReference: invoice.po_reference ?? null,
          goodsReceived: invoice.goods_received === true,
          entry: decided ? { ts: decided.ts, detail: decided.detail } : null,
        })
      ) || "The agent has not evaluated this invoice yet.",
    evidence: [
      { label: "PO", value: invoice.po_reference ?? "none", state: invoice.po_reference ? "ok" : "missing" },
      { label: "Goods received", value: invoice.goods_received ? "yes" : "no", state: invoice.goods_received ? "ok" : "missing" },
      { label: "Risk", value: risk, state: risk === "high" ? "missing" : "neutral" },
      { label: "Limit", value: counterparty?.payment_limit == null ? "none" : `${fmt(counterparty.payment_limit)} USDC`, state: counterparty?.payment_limit != null && usdcValue != null && usdcValue > counterparty.payment_limit ? "missing" : "neutral" },
      eurc && entry
        ? usdcValue != null
          ? { label: "USDC value", value: `${fmt(usdcValue)} USDC${rate != null ? ` at ${rate}` : ""}`, state: "neutral" as const }
          : { label: "USDC value", value: "no rate", state: "missing" as const }
        : null,
      { label: "Due", value: new Date(invoice.due_date).toLocaleDateString("en-US"), state: "neutral" },
      termsEvidence(invoice),
      paidEvidence(invoice),
      eurc ? swapEvidence(entry?.detail) : null,
      paidAcrossChains(counterparty?.chain) ? { label: "Payee's chain", value: `${payeeChain(counterparty?.chain).label}, through ${route}${routeFees ?? ""}`, state: "neutral" as const } : null,
      duplicateEvidence(observed),
    ].filter((item): item is Evidence => item !== null),
    guardrail: guardrailBlocked ? invoiceGuardrail(invoice.amount, currency, usdcValue, limit, risk, rule, entry?.detail) : null,
    decisionMode: stringValue(entry?.detail.decisionMode),
    // A Gateway payout has no Arc transaction of its own: its hash is the mint, linked below on the payee's
    // chain. No mint is ever linked to Arc's explorer (Gateway review I4).
    txHash: invoice.tx_ref?.startsWith("0x") && route !== "Gateway" && invoice.tx_ref !== mint?.txHash ? invoice.tx_ref : null,
    mint,
    auditSeq: entry?.seq,
    at: entry?.ts ?? invoice.due_date,
  };
}

/** The route a payout across chains took, as its decision recorded it: Gateway, or CCTP (the only route before Gateway). */
function payoutRouteLabel(detail: Record<string, unknown> | undefined): "Gateway" | "CCTP" {
  return stringValue(record(detail?.payout)?.route) === "gateway" ? "Gateway" : "CCTP";
}

/**
 * The route a payout across chains took, from whichever of the invoice's entries recorded one (Gateway
 * review I4): a later reconcile records none of its own. CCTP when none did.
 */
function routeOf(invoiceId: string, entries: LedgerEntry[]): "Gateway" | "CCTP" {
  const decided = entries.find((entry) => entry.detail.invoiceId === invoiceId && stringValue(record(entry.detail.payout)?.route) !== undefined);
  return payoutRouteLabel(decided?.detail);
}

/**
 * The route's fee set against the other route's, as the decision that chose it recorded both
 * (` at 0.107811 USDC, against 0.135342 USDC through CCTP`); null when it did not record both.
 */
function routeFeesOf(invoiceId: string, entries: LedgerEntry[]): string | null {
  const decided = entries.find((entry) => entry.detail.invoiceId === invoiceId && record(record(entry.detail.payout)?.quotes) !== undefined);
  const payout = record(decided?.detail.payout);
  const quotes = record(payout?.quotes);
  const cctp = numberValue(quotes?.cctpFeeUsdc);
  const gateway = numberValue(quotes?.gatewayFeeUsdc);
  if (cctp === undefined || gateway === undefined) return null;
  return stringValue(payout?.route) === "gateway" ? ` at ${gateway} USDC, against ${cctp} USDC through CCTP` : ` at ${cctp} USDC, against ${gateway} USDC through Gateway`;
}

/** A bridged payment's mint, from whichever of the invoice's entries recorded it: the decision, or a later reconcile. */
function mintOf(invoiceId: string, entries: LedgerEntry[]): Decision["mint"] {
  for (const entry of entries) {
    if (entry.detail.invoiceId !== invoiceId) continue;
    const execution = record(entry.detail.execution);
    const txHash = stringValue(execution?.mintTxHash);
    // A simulated mint has nothing on chain to link (review M3).
    if (!txHash || !txHash.startsWith("0x")) continue;
    const chain = payeeChain(stringValue(execution?.destinationChain));
    return { chainLabel: chain.label, txHash, href: `${chain.explorerTx}${txHash}` };
  }
  return null;
}

/**
 * The band a refused invoice shows. A USDC invoice reads as it always has. A
 * EURC one names its own rule: no rate (EURC against a USDC limit it could not
 * be weighed on), not enough EURC (what it would send against the wallet's
 * EURC), or the limit (its USDC value against the limit).
 */
function invoiceGuardrail(
  amount: number,
  currency: string,
  usdcValue: number | null,
  limit: number,
  risk: string,
  inferredRule: string,
  detail: Record<string, unknown> | undefined
): Guardrail {
  const recorded = stringValue(detail?.guardrailRule);
  // A payout to another chain code held (CCTP payouts X4–X6, review I1): its
  // own rule, and for a costly one the fee against what 10% of the invoice allows.
  if (recorded === "bridge.fee_above_cap") {
    const fee = numberValue(record(detail?.payout)?.feeUsdc) ?? 0;
    return { rule: recorded, attempted: fee, limit: Math.round(amount * BRIDGE_FEE_CAP_PERCENT * 10_000) / 1_000_000, note: `${payoutRouteLabel(detail)} fee, against ${BRIDGE_FEE_CAP_PERCENT}% of the invoice` };
  }
  if (recorded === "bridge.fee_unavailable") return { rule: recorded, attempted: amount, limit, note: `no ${payoutRouteLabel(detail)} fee from Circle` };
  // A payout its first attempt sent through Gateway, and the Gateway balance no longer covers (Gateway review I3).
  if (recorded === "bridge.gateway_balance_short") {
    const payout = record(detail?.payout);
    const needed = Math.round((amount + (numberValue(payout?.feeUsdc) ?? 0)) * 1_000_000) / 1_000_000;
    return { rule: recorded, attempted: needed, limit: numberValue(payout?.gatewayBalanceUsdc) ?? 0, note: "the Gateway balance, which an earlier attempt's route requires" };
  }
  if (recorded === "bridge.unsupported_token") return { rule: recorded, attempted: amount, attemptedToken: currency, limit, limitToken: "USDC", note: "only USDC crosses chains" };
  // The agent's spending limit (outflow budget spec §4): the USDC value against what the limit left.
  const budget = recorded === "workspace.outflow_budget" ? budgetGuardrail(usdcValue ?? amount, detail) : null;
  if (budget) return budget;
  if (currency !== "EURC") {
    return { rule: inferredRule, attempted: amount, limit, note: risk === "high" ? "risk tier high" : "amount above screened limit" };
  }
  if (recorded === "fx.rate_unavailable") {
    return { rule: recorded, attempted: amount, attemptedToken: "EURC", limit, limitToken: "USDC", note: "no EURC→USDC rate to weigh it at" };
  }
  // A swap code refused to fund the payment with (EURC swap spec S5).
  if (recorded === "fx.swap_cost_above_cap") {
    return { rule: recorded, attempted: numberValue(record(detail?.swapOffer)?.costPercent) ?? 0, attemptedToken: "%", limit: SWAP_COST_CAP_PERCENT, limitToken: "%", note: "the swap's cost above the quoted rate" };
  }
  if (recorded === "fx.swap_usdc_short") {
    const left = (numberValue(record(detail?.observed)?.operatingBalance) ?? 0) - (numberValue(record(detail?.swapOffer)?.usdcIn) ?? 0);
    return {
      rule: recorded,
      attempted: Math.round(left * 1_000_000) / 1_000_000,
      attemptedToken: "USDC",
      limit: numberValue(detail?.usdcDueWithin7Days) ?? 0,
      limitToken: "USDC",
      note: "USDC left after the swap, against what falls due within 7 days",
    };
  }
  if (recorded === "treasury.insufficient_eurc") {
    return { rule: recorded, attempted: amount, attemptedToken: "EURC", limit: numberValue(detail?.eurcBalance) ?? 0, limitToken: "EURC", note: "EURC in the operating wallet" };
  }
  return {
    rule: recorded ?? inferredRule,
    attempted: usdcValue ?? amount,
    attemptedToken: usdcValue != null ? "USDC" : "EURC",
    limit,
    limitToken: "USDC",
    note: risk === "high" ? "risk tier high" : "USDC value above screened limit",
  };
}

/**
 * The band for a payment held for the agent's spending limit (outflow budget spec §4): what it
 * would have sent, in USDC, against what the limit left, and which figure stopped it after what.
 * Null when the decision recorded no limit.
 */
function budgetGuardrail(attemptedUsdc: number, detail: Record<string, unknown> | undefined): Guardrail | null {
  const room = record(detail?.outflowBudget);
  if (!room) return null;
  const week = room.binding === "week";
  const figure = numberValue(week ? room.weeklyUsdc : room.dailyUsdc) ?? 0;
  const spent = numberValue(week ? room.spentThisWeek : room.spentToday) ?? 0;
  return {
    rule: "workspace.outflow_budget",
    attempted: attemptedUsdc,
    attemptedToken: "USDC",
    limit: numberValue(room.remaining) ?? 0,
    limitToken: "USDC",
    note: week
      ? `left of the ${fmt(figure)} USDC 7-day spending limit; ${fmt(spent)} USDC already paid in the last 7 days`
      : `left of the ${fmt(figure)} USDC daily spending limit; ${fmt(spent)} USDC already paid today`,
  };
}

/** A milestone's evidence as a link a person can open: an https address, other than a pull request (the Verified by row links that). */
function milestoneEvidenceLink(source: string | null, githubSource: string | undefined): { href: string; host: string } | null {
  if (!source || githubSource) return null;
  try {
    const url = new URL(source);
    return url.protocol === "https:" && url.hostname ? { href: url.href, host: url.hostname } : null;
  } catch {
    return null;
  }
}

/**
 * What the card knows of the contractor now, beyond the decision's own record: its screening, for a milestone
 * the agent has not decided yet, and what a verified milestone waits for before the agent pays it (the
 * contractor stage's payeeNotReady): an address someone must confirm, or one the payee has still to add.
 */
export interface MilestoneContext {
  riskLevel?: string | null;
  waiting?: "unconfirmed" | "no_address" | null;
}

/** A milestone not yet decided, or decided and on its way, as its card says it (never "Scheduled"). */
function milestoneProgress(milestone: MilestoneRow, waiting: MilestoneContext["waiting"]): { label: string; line: string } | null {
  const name = milestone.contractor_name;
  if (milestone.status === "pending") return { label: "Awaiting verification", line: "The agent is waiting for milestone verification." };
  if (milestone.status !== "verified") return null;
  if (waiting === "unconfirmed") {
    return { label: "Address to confirm", line: `Verified. ${name}'s address changed and no one has confirmed it yet: confirm it on Counterparties, and the agent decides on pay within a minute.` };
  }
  if (waiting === "no_address") return { label: "Waiting for an address", line: `Verified. ${name} has not added an address yet: the agent pays once they add one through their payee link.` };
  if (milestone.tx_ref) return { label: "Payment in flight", line: "Verified. The payment was sent and is waiting for Circle to confirm it." };
  return { label: "Being decided", line: "Verified. The agent decides on pay within a minute." };
}

export function milestoneDecision(milestone: MilestoneRow, entries: LedgerEntry[], context: MilestoneContext = {}): Decision {
  const entry = matchingEntry(entries, "milestoneId", milestone.id);
  // What the agent observed when it last decided: a person's decision after it (Pay now, Close) records none.
  const decided = entries.find((candidate) => candidate.detail.milestoneId === milestone.id && record(candidate.detail.observed));
  const observed = record(decided?.detail.observed);
  const closed = milestone.status === "closed";
  const guardrailBlocked = !closed && entry?.detail.guardrailBlocked === true;
  const limit = numberValue(observed?.paymentLimit) ?? 0;
  // The screening the agent decided on, or, before any decision, the contractor's own.
  const risk = stringValue(observed?.riskLevel) ?? context.riskLevel ?? "unscreened";
  const progress = closed ? null : milestoneProgress(milestone, context.waiting);
  // A verified milestone held back for a person to confirm an address waits on someone, as a held one does.
  const waitsOnPerson = milestone.status === "verified" && context.waiting === "unconfirmed";
  const presented = presentReasoning(milestone.agent_reasoning, explainMilestone({ name: milestone.contractor_name, amount: milestone.amount, entry: decided ? { detail: decided.detail } : null }));
  const githubSource = milestone.verification_source?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/)?.[0];
  const verificationLabel = milestone.verification_method === "github"
    ? milestone.verification_status === "verified" ? "merged PR" : milestone.verification_status.replace("_", " ")
    : milestone.verification_method === "manual" ? "manual approval" : milestone.verification_method === "seed" ? "demo fixture" : "not verified";
  const evidenceLink = milestoneEvidenceLink(milestone.verification_source, githubSource);
  return {
    id: milestone.id,
    domain: "contractor",
    action: "Release",
    subject: milestone.contractor_name,
    memo: milestone.title,
    amount: milestone.amount,
    token: "USDC",
    outcome: closed ? "recorded" : waitsOnPerson ? "held" : statusOutcome(milestone.status, milestone.tx_ref, guardrailBlocked),
    ...(closed ? { outcomeLabel: "Closed without paying" } : progress && !guardrailBlocked ? { outcomeLabel: progress.label } : {}),
    // What it waits for now comes after what the agent last decided, if it decided before.
    reasoning: [presented, progress && (milestone.status !== "pending" || !presented) ? progress.line : ""].filter(Boolean).join(" ") || "The agent is waiting for milestone verification.",
    evidence: [
      { label: "Verified by", value: verificationLabel, href: githubSource, state: milestone.verified ? "ok" : "missing" },
      { label: "Verified", value: milestone.verified ? "yes" : "not yet", state: milestone.verified ? "ok" : "missing" },
      ...(evidenceLink ? [{ label: "Evidence", value: evidenceLink.host, href: evidenceLink.href, state: "neutral" as const }] : []),
      { label: "Risk", value: risk, state: risk === "high" ? "missing" : "neutral" },
    ],
    guardrail: guardrailBlocked
      ? (entry?.detail.guardrailRule === "workspace.outflow_budget" ? budgetGuardrail(milestone.amount, entry.detail) : null) ??
        { rule: risk === "high" ? "counterparty.high_risk" : "counterparty.payment_limit", attempted: milestone.amount, limit, note: risk === "high" ? "risk tier high" : "amount above screened limit" }
      : null,
    decisionMode: stringValue(decided?.detail.decisionMode ?? entry?.detail.decisionMode),
    txHash: milestone.tx_ref?.startsWith("0x") ? milestone.tx_ref : null,
    auditSeq: entry?.seq,
    at: entry?.ts ?? new Date().toISOString(),
  };
}

const TREASURY_DECISIONS = new Set(["hold", "sweep_to_usyc", "redeem_from_usyc"]);

/**
 * The treasury stage's own decisions among treasury-domain entries, newest first, at most `count`. A swap
 * of USDC for EURC or a Gateway deposit is in the same domain but is no decision on the reserve, and is
 * never shown as one (EURC swap review #8).
 */
export function treasuryDecisionEntries(entries: LedgerEntry[], count: number): LedgerEntry[] {
  return entries.filter((entry) => TREASURY_DECISIONS.has(entry.action)).slice(0, count);
}

export function treasuryLedgerDecision(entry: LedgerEntry): Decision {
  const decision = record(entry.detail.decision);
  const economics = record(entry.detail.economics);
  const action = stringValue(decision?.action) ?? entry.action;
  const amount = numberValue(decision?.amount) ?? 0;
  const earnMode = stringValue(entry.detail.earnMode);
  const executed = entry.detail.executed === true;
  // A real USYC move's transaction (USYC live design R7): the deposit or the redemption.
  const execution = record(entry.detail.execution);
  const moveTx = stringValue(execution?.depositTxHash) ?? stringValue(execution?.redeemTxHash);
  const outcome: Outcome = action === "hold" ? "held" : earnMode === "live" && executed ? "recorded" : "simulated";
  const title = action === "sweep_to_usyc" ? "Sweep" : action === "redeem_from_usyc" ? "Redeem" : "Hold";
  const evidence = [
    { label: "Idle above buffer", value: `${fmt(numberValue(economics?.idleAboveBuffer) ?? 0)} USDC`, state: "neutral" as const },
    { label: "Required buffer", value: `${fmt(numberValue(economics?.requiredBuffer) ?? 0)} USDC`, state: "neutral" as const },
    { label: "Hold horizon", value: `${numberValue(economics?.expectedHoldDays) ?? 0} day(s)`, state: "neutral" as const },
    { label: "Projected yield", value: `$${fmt(numberValue(economics?.projectedYieldUsd) ?? 0)}`, state: "neutral" as const },
    { label: "Round-trip cost", value: `$${fmt(numberValue(economics?.roundTripCostUsd) ?? 0)}`, state: "neutral" as const },
  ];

  return {
    id: entry.id,
    domain: "treasury",
    action: title,
    subject: title === "Hold" ? "operating cash" : "USDC ↔ USYC reserve",
    amount: amount > 0 ? amount : undefined,
    token: "USDC",
    outcome,
    outcomeLabel: title === "Hold" ? "Held liquid" : undefined,
    reasoning: presentReasoning(stringValue(decision?.reasoning) ?? entry.summary, explainTreasury(entry.detail)) || entry.summary,
    evidence,
    decisionMode: stringValue(entry.detail.decisionMode),
    txHash: earnMode === "live" && executed && moveTx?.startsWith("0x") ? moveTx : null,
    auditSeq: entry.seq,
    at: entry.ts,
  };
}

export function treasuryActionDecision(action: TreasuryActionRow): Decision {
  const title = action.action === "sweep_to_usyc" ? "Sweep" : "Redeem";
  return {
    id: action.id,
    domain: "treasury",
    action: action.action === "sweep_to_usyc" ? "Sweep" : "Redeem",
    subject: action.action === "sweep_to_usyc" ? "USDC → USYC reserve" : "USYC reserve → USDC",
    amount: action.amount,
    token: "USDC",
    outcome: "simulated",
    reasoning: presentReasoning(action.reasoning) || `${title} of ${fmt(action.amount)} USDC, simulated.`,
    evidence: [],
    at: action.created_at,
  };
}
