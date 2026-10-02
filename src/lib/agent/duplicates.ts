/**
 * Duplicate-invoice detection.
 *
 * The agent's system prompt has always told the model to "flag it rather than
 * holding quietly" when evidence suggests fraud, and named *a duplicate
 * invoice* as the first example. Nothing ever computed duplicates or put them
 * in the decision context, so the model was being instructed to do something it
 * had no way of doing: it sees one invoice at a time and cannot know an
 * identical one was paid last week.
 *
 * Duplicate billing is the most ordinary AP fraud there is, and the most
 * ordinary AP *mistake* — a vendor re-sends an unpaid invoice, someone forwards
 * a PDF twice, an integration replays. The loss is the same either way.
 *
 * The hard part is not spotting repeats. It is not crying wolf at a recurring
 * charge, which by design looks almost identical every month: same vendor, same
 * amount, same memo. The difference is that a legitimate recurring charge lands
 * on a *different billing period* and carries its own purchase order, while a
 * duplicate points at the same one. That distinction is what `RECURRING_*`
 * below encodes, and it is why matching on amount alone would be useless.
 *
 * Pure and I/O-free: the caller supplies the candidates, so the whole policy is
 * testable and the same scores can be shown to the model, written to the
 * ledger, and rendered in the UI without being recomputed three different ways.
 */

export interface InvoiceLike {
  id: string;
  counterpartyId: string;
  amount: number;
  /** USDC when absent. The same figure in two currencies is not the same amount. */
  currency?: string;
  memo: string | null;
  poReference: string | null;
  dueDate: string;
  status: string;
  /** The recurring payment it was created for, and its period, when it was (recurring payments R1, R4). */
  recurringId?: string | null;
  recurringPeriod?: string | null;
}

export type DuplicateSignal =
  | "same_purchase_order"
  | "same_amount"
  | "same_memo"
  | "close_due_dates"
  | "purchase_order_rebilled";

export interface DuplicateMatch {
  /** The earlier invoice this one appears to repeat. */
  otherId: string;
  otherStatus: string;
  otherDueDate: string;
  otherAmount: number;
  confidence: number;
  signals: DuplicateSignal[];
  /** Plain-language account of the match, written into the ledger verbatim. */
  explanation: string;
  /**
   * True when the match is against an invoice whose money has already gone
   * or is committed to go: paid, a payment in flight, scheduled, or being
   * approved and paid by a person right now.
   */
  againstSettled: boolean;
}

/**
 * A repeat of an invoice whose money has left, or is committed to leave, is
 * the one that costs money: paid (`paid`, or `received` on the other side of
 * the book), a payment in flight (`matched`), one the agent has scheduled to
 * pay (`scheduled`), or one a person has claimed on Approvals and is paying
 * right now (`processing`, `claim_invoice_decision` in migration 0025). A
 * repeat of a scheduled invoice scheduled too would be paid twice on the day;
 * so would one paid while the first is in flight, or while a person pays it.
 */
const COMMITTED_STATUSES = new Set(["paid", "received", "matched", "scheduled", "processing"]);

/**
 * How a committed invoice is described in a match's explanation, and on the
 * decision card's duplicate evidence (src/components/vx/map.ts); null for a
 * status whose money is not committed.
 */
export function committedState(status: string): string | null {
  if (status === "paid" || status === "received") return "already paid";
  if (status === "matched") return "already being paid";
  if (status === "scheduled") return "already scheduled";
  if (status === "processing") return "already being decided by a person";
  return null;
}

/** At or above this, the agent refuses in code rather than asking the model. */
export const DUPLICATE_BLOCK_CONFIDENCE = 0.9;

/** At or above this, the match is put in front of the model as evidence. */
export const DUPLICATE_REPORT_CONFIDENCE = 0.45;

/** Strongest duplicate candidates included in one model decision context. */
export const DUPLICATE_MATCHES_IN_CONTEXT = 5;

/**
 * A monthly charge falls somewhere near here. Two invoices this far apart are
 * evidence *against* duplication, however alike they otherwise look — which is
 * the check that keeps every subscription in the book from being flagged.
 */
const RECURRING_MIN_DAYS = 24;
const RECURRING_MAX_DAYS = 32;

const DAY_MS = 86_400_000;

function normaliseText(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.toLowerCase().replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Purchase orders are quoted inconsistently: "PO-1042", "po 1042", "1042". */
function normalisePo(value: string | null): string | null {
  if (!value) return null;
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const stripped = compact.replace(/^po/, "");
  return stripped.length === 0 ? null : stripped;
}

function sameMoney(a: number, b: number): boolean {
  // USDC carries six decimals; compare at that precision, not with ===.
  return Math.abs(a - b) < 0.0000005;
}

function daysApart(a: string, b: string): number | null {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(left - right) / DAY_MS;
}

function describe(
  confidence: number,
  signals: DuplicateSignal[],
  candidate: InvoiceLike,
  gapDays: number | null
): string {
  const when = candidate.dueDate.slice(0, 10);
  const state = committedState(candidate.status) ?? `status ${candidate.status}`;
  const gap =
    gapDays == null
      ? ""
      : gapDays < 1
        ? " with the same due date"
        : ` ${gapDays.toFixed(0)} day(s) apart`;

  if (signals.includes("same_purchase_order") && signals.includes("same_amount")) {
    return `Bills the same purchase order for the same ${candidate.amount} ${candidate.currency ?? "USDC"} as invoice due ${when} (${state})${gap}. Paying both would pay one obligation twice.`;
  }
  if (signals.includes("purchase_order_rebilled")) {
    return `Cites the same purchase order as invoice due ${when} (${state}) but for a different amount (${candidate.amount} ${candidate.currency ?? "USDC"}). Either an amendment or the order being billed twice; the difference needs confirming before payment.`;
  }
  if (signals.includes("same_amount") && signals.includes("same_memo")) {
    return `Same counterparty, same ${candidate.amount} ${candidate.currency ?? "USDC"}, same description as invoice due ${when} (${state})${gap}, and no purchase order distinguishes them.`;
  }
  return `Resembles invoice due ${when} (${state}): ${signals.join(", ")}. Confidence ${confidence.toFixed(2)}.`;
}

/**
 * Scores one invoice against one earlier candidate. Returns null when there is
 * nothing worth reporting — a weak resemblance is noise, and an agent that
 * flags noise gets its flags ignored.
 */
export function scoreDuplicate(
  invoice: InvoiceLike,
  candidate: InvoiceLike
): DuplicateMatch | null {
  if (candidate.id === invoice.id) return null;
  // Two vendors sending the same amount is a coincidence, not a duplicate.
  if (candidate.counterpartyId !== invoice.counterpartyId) return null;
  // Two periods of one recurring payment are two obligations by construction: the schedule makes
  // one invoice a period, and the database refuses a second (recurring payments R1, R4). A typed
  // invoice that repeats one of them is still checked like any other.
  if (
    invoice.recurringId &&
    invoice.recurringId === candidate.recurringId &&
    invoice.recurringPeriod &&
    candidate.recurringPeriod &&
    invoice.recurringPeriod !== candidate.recurringPeriod
  ) {
    return null;
  }

  const signals: DuplicateSignal[] = [];
  const po = normalisePo(invoice.poReference);
  const candidatePo = normalisePo(candidate.poReference);
  const samePo = po != null && candidatePo != null && po === candidatePo;
  // The same figure in another currency is a different amount: 100 EURC is not
  // 100 USDC. A purchase order billed again in the other currency is still
  // reported below, as a re-bill to confirm (EURC invoices design, review I1).
  const sameAmount = (invoice.currency ?? "USDC") === (candidate.currency ?? "USDC") && sameMoney(invoice.amount, candidate.amount);
  const memo = normaliseText(invoice.memo);
  const candidateMemo = normaliseText(candidate.memo);
  const sameMemo = memo != null && candidateMemo != null && memo === candidateMemo;
  const gapDays = daysApart(invoice.dueDate, candidate.dueDate);

  let confidence = 0;

  if (samePo && sameAmount) {
    signals.push("same_purchase_order", "same_amount");
    confidence = 0.95;
  } else if (samePo) {
    signals.push("purchase_order_rebilled");
    confidence = 0.55;
  } else if (sameAmount) {
    signals.push("same_amount");
    confidence = 0.4;
    if (sameMemo) {
      signals.push("same_memo");
      confidence = 0.75;
    }
    if (gapDays != null && gapDays <= 3) {
      signals.push("close_due_dates");
      confidence = Math.max(confidence, sameMemo ? 0.88 : 0.6);
    }
  }

  if (confidence === 0) return null;

  // The recurring-charge exemption. A monthly subscription repeats the vendor,
  // the amount and the wording every cycle; what it does not do is re-use the
  // same purchase order. Without this, every subscription in the book would be
  // reported as fraud once a month and the signal would be worthless.
  if (
    !samePo &&
    gapDays != null &&
    gapDays >= RECURRING_MIN_DAYS &&
    gapDays <= RECURRING_MAX_DAYS
  ) {
    return null;
  }

  const againstSettled = COMMITTED_STATUSES.has(candidate.status);
  // A repeat of an invoice that is itself still undecided or held is worth
  // raising, but it is not yet a loss — nothing has left the account, or is
  // committed to. Only a repeat of paid or committed money justifies refusing
  // in code.
  if (!againstSettled) confidence = Math.min(confidence, 0.85);

  if (confidence < DUPLICATE_REPORT_CONFIDENCE) return null;

  return {
    otherId: candidate.id,
    otherStatus: candidate.status,
    otherDueDate: candidate.dueDate,
    otherAmount: candidate.amount,
    confidence: Number(confidence.toFixed(2)),
    signals,
    explanation: describe(confidence, signals, candidate, gapDays),
    againstSettled,
  };
}

function applyMatchLimit(matches: DuplicateMatch[], limit: number): DuplicateMatch[] {
  if (limit === Number.POSITIVE_INFINITY) return matches;
  return matches.slice(0, Math.max(0, Math.floor(limit)));
}

/** Reportable matches for one invoice, strongest first and capped by default. */
/**
 * Every reportable match, strongest first — deliberately uncapped.
 *
 * Detection and presentation are different jobs and only one of them may be
 * truncated. A cap here would be a footgun with the safety off: any call site
 * that forgot to ask for the complete set would silently stop blocking the
 * sixth duplicate a vendor submitted, no test would fail, and the app would run
 * exactly as before while the fraud guardrail quietly weakened. Truncation
 * lives in `duplicateMatchContext`, which is only ever used to build a prompt.
 */
export function findDuplicates(
  invoice: InvoiceLike,
  candidates: InvoiceLike[]
): DuplicateMatch[] {
  return candidates
    .map((candidate) => scoreDuplicate(invoice, candidate))
    .filter((match): match is DuplicateMatch => match !== null)
    .sort((a, b) => b.confidence - a.confidence);
}

export function duplicateMatchContext(
  allMatches: DuplicateMatch[],
  limit = DUPLICATE_MATCHES_IN_CONTEXT
): { matches: DuplicateMatch[]; total: number } {
  return {
    matches: applyMatchLimit(allMatches, limit),
    total: allMatches.length,
  };
}

/**
 * The match that justifies refusing payment outright, if there is one: a
 * high-confidence repeat of money that has already left the account, or is
 * committed to — in flight, scheduled, or being paid by a person.
 */
export function blockingDuplicate(matches: DuplicateMatch[]): DuplicateMatch | null {
  return (
    matches.find((m) => m.againstSettled && m.confidence >= DUPLICATE_BLOCK_CONFIDENCE) ?? null
  );
}
