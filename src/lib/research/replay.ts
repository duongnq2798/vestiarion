import type { ApPromptFacts } from "@/lib/agent/orchestrator";

/**
 * The facts of a recorded payable decision, rebuilt to ask the model again
 * with today's prompt (scripts/replay-ap-decisions.ts). The ledger entry
 * records what the decision weighed (`observed`, and `timing` from the day
 * timing was recorded); the invoice and counterparty rows give what it did
 * not record, while they exist. A replay asks today's question about the
 * recorded facts: it measures a prompt change, not the original moment.
 */

export interface ReplayEntry {
  seq: number;
  ts: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface ReplayRows {
  invoice: { memo: string | null; due_date: string } | null;
  counterparty: { name: string } | null;
  /** The other invoices the duplicate check named, by id, while they exist. */
  others: Map<string, { amount: number; due_date: string }>;
}

interface RecordedMatch {
  finding: string;
  signals: string[];
  confidence: number;
  otherInvoiceId: string;
  otherInvoiceStatus: string;
}

/** The timing keys the model is shown; the policy's recommendation and reason are withheld (orchestrator timingFacts). */
const TIMING_KEYS = ["today", "dueOn", "discountValue", "discountAvailableUntil", "floatValueToDue", "targetOn", "amountDueAtTarget", "earlierObligations", "shortfall"] as const;

const day = (iso: string) => iso.slice(0, 10);

export function factsFromEntry(entry: ReplayEntry, rows: ReplayRows): ApPromptFacts {
  const observed = (entry.detail.observed ?? {}) as Record<string, unknown>;
  const amount = Number(observed.amount);
  const currency = entry.detail.currency === "EURC" ? "EURC" : "USDC";
  const dueDate = rows.invoice?.due_date ?? (entry.detail.timing as { dueOn?: string } | undefined)?.dueOn ?? day(entry.ts);
  const check = (observed.duplicateCheck ?? { matches: [], matchesTotal: 0 }) as { matches: RecordedMatch[]; matchesTotal: number };

  const recordedTiming = entry.detail.timing as Record<string, unknown> | undefined;
  const timing = recordedTiming
    ? Object.fromEntries(TIMING_KEYS.map((key) => [key, recordedTiming[key]]))
    : {
        // Before timing was recorded (2026-09-30): due the day it was decided, as these invoices were.
        today: day(entry.ts),
        dueOn: day(dueDate),
        discountValue: 0,
        discountAvailableUntil: null,
        floatValueToDue: 0,
        targetOn: day(entry.ts),
        amountDueAtTarget: amount,
        earlierObligations: { total: 0, count: 0 },
        shortfall: false,
      };

  return {
    invoice: {
      amount,
      currency,
      usdcValue: currency === "USDC" ? amount : ((entry.detail.usdcValue as number | null | undefined) ?? null),
      memo: rows.invoice?.memo ?? null,
      poReference: (observed.poReference as string | null | undefined) ?? null,
      goodsReceived: observed.goodsReceived === true,
      dueDate,
    },
    terms: (entry.detail.terms as { earlyPayDiscount: unknown } | undefined) ?? { earlyPayDiscount: null },
    counterparty: {
      name: rows.counterparty?.name ?? /from (.+?) for /.exec(entry.summary)?.[1] ?? "the counterparty",
      riskLevel: String(observed.riskLevel ?? "clear"),
      paymentLimit: (observed.paymentLimit as number | null | undefined) ?? null,
      performanceHistory: observed.performanceHistory ?? null,
    },
    treasury: { operatingBalance: (observed.operatingBalance as number | null | undefined) ?? null, reserveBalance: 0 },
    payout: entry.detail.payout ?? { chain: "Arc testnet", route: "direct" },
    timing,
    scheduledEarlier: null,
    duplicateMatches: check.matches.map((match) => {
      const other = rows.others.get(match.otherInvoiceId);
      return {
        otherInvoiceStatus: match.otherInvoiceStatus,
        otherInvoiceDueDate: other?.due_date ?? /due (\d{4}-\d{2}-\d{2})/.exec(match.finding)?.[1] ?? null,
        otherInvoiceAmount: other?.amount ?? amount,
        confidence: match.confidence,
        signals: match.signals,
        finding: match.finding,
      };
    }),
    duplicateMatchesTotal: check.matchesTotal,
  };
}
