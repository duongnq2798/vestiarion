import { createHash } from "node:crypto";
import type { InsightsData } from "@/lib/insights";
import type { LedgerEntry } from "@/lib/ledger";

/**
 * A page of the audit log and a workspace's insights, at the sizes production showed on Oct 30 (audit and insights
 * payload): a hundred entries whose detail runs about 2 KB of JSON each, most of it the agent's bill decisions, and the
 * longest history the insights reads return (120 cycles, snapshots, transfers and treasury moves, 500 screening checks).
 */

const hex = (seed: string, length = 64) => {
  let out = "";
  for (let round = 0; out.length < length; round += 1) out += createHash("sha256").update(`${seed}:${round}`).digest("hex");
  return out.slice(0, length);
};
const uuid = (seed: string) => {
  const h = hex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 26, 8, 0) + minutes * 60_000).toISOString();

const VENDORS = ["Northwind Supplies", "Cobalt Freight", "Harbor Print Co.", "Juniper Cloud", "Meridian Legal", "Atlas Office"];

function billDecision(seq: number): Pick<LedgerEntry, "actor" | "domain" | "action" | "summary" | "detail"> {
  const vendor = VENDORS[seq % VENDORS.length];
  const amount = 180 + ((seq * 37) % 900);
  const action = seq % 5 === 0 ? "hold" : seq % 7 === 0 ? "schedule" : "pay";
  const settled = action === "pay";
  return {
    actor: "agent",
    domain: "ap",
    action: `ap_${action}`,
    summary: `${action.toUpperCase()} invoice from ${vendor} for ${amount} USDC`,
    detail: {
      invoiceId: uuid(`invoice-${seq}`),
      counterpartyId: uuid(`vendor-${seq % VENDORS.length}`),
      decision: {
        action,
        reasoning: `${vendor} has been paid on time for the last six invoices with no disputes, the amount is inside the payment limit, and the bill matches purchase order PO-${4100 + seq} line for line. Paying now keeps the vendor's terms and leaves the operating balance above the seven-day obligations.`,
        confidence: 0.86,
        payOn: at((seq % 100) * 15).slice(0, 10),
      },
      decisionMode: "model",
      referenceDecision: { action, reasoning: "Within limit, known vendor, purchase order matched, no risk flags." },
      agreedWithReference: true,
      guardrailBlocked: false,
      guardrailRule: null,
      currency: "USDC",
      vendorDocument: { requestId: uuid(`request-${seq}`), source: "email", fileSha256: hex(`document-${seq}`) },
      timing: { dueDate: at((seq % 100) * 15 + 14 * 1440).slice(0, 10), daysUntilDue: 14, discountDeadline: null, termsDays: 30 },
      timingRule: "pay_when_due_is_near",
      terms: { netDays: 30, discountPercent: null, lateFeePercent: 1.5 },
      ...(settled ? { amountPaid: amount, discountTaken: 0 } : {}),
      outflowBudget: { period: "week", limit: 12_000, spent: 4_310.25 + (seq % 100), remaining: 7_689.75 - (seq % 100) },
      guardrails: [
        { rule: "payment_limit", passed: true, detail: `${amount} USDC is within the 2,500 USDC limit` },
        { rule: "counterparty_risk", passed: true, detail: "low risk, screened within 7 days" },
        { rule: "duplicate_invoice", passed: true, detail: "no other invoice with this number and amount" },
        { rule: "operating_floor", passed: true, detail: "the balance stays above the 5,000 USDC floor" },
      ],
      observed: {
        amount,
        paymentLimit: 2500,
        riskLevel: "low",
        performanceHistory: { invoicesPaid: 6, paidOnTime: 6, disputes: 0, lastPaidAt: at((seq % 100) * 15 - 7 * 1440) },
        operatingBalance: 18_420.55 - (seq % 100) * 12.5,
        obligationsDue7d: 3_120.4,
      },
      execution: settled
        ? { txRef: `0x${hex(`tx-${seq}`)}`, chainMode: "live", providerMode: "live", feeUsd: 0.003112, settledInMs: 812 + seq, resultingStatus: "paid" }
        : { txRef: null, chainMode: "live", resultingStatus: action === "hold" ? "held" : "scheduled" },
      day: 0,
      clockMode: "real",
    },
  };
}

function screening(seq: number): Pick<LedgerEntry, "actor" | "domain" | "action" | "summary" | "detail"> {
  const vendor = VENDORS[seq % VENDORS.length];
  return {
    actor: "system",
    domain: "compliance",
    action: seq % 4 === 0 ? "compliance_sweep" : "counterparty_screened",
    summary: `Screened ${vendor}: low risk, no matches on the sanctions lists`,
    detail: {
      counterpartyId: uuid(`vendor-${seq % VENDORS.length}`),
      counterpartyName: vendor,
      riskLevel: "low",
      previousRiskLevel: "low",
      source: "OpenSanctions",
      screeningMode: "live",
      datasets: ["us_ofac_sdn", "eu_fsf", "un_sc_sanctions", "gb_hmt_sanctions"],
      matches: [],
      checkedAt: at((seq % 100) * 15),
      walletAddress: `0x${hex(`wallet-${seq % VENDORS.length}`, 40)}`,
      day: 0,
      clockMode: "real",
    },
  };
}

function treasuryMove(seq: number): Pick<LedgerEntry, "actor" | "domain" | "action" | "summary" | "detail"> {
  return {
    actor: "agent",
    domain: "treasury",
    action: "sweep_to_usyc",
    summary: `Swept 1,200 USDC above the operating floor into USYC`,
    detail: {
      amount: 1200,
      txRef: `0x${hex(`sweep-${seq}`)}`,
      usycPrice: 1.0412,
      floor: 15_000,
      liquidBefore: 16_200.25,
      liquidAfter: 15_000.25,
      reasoning: "The operating balance is above the floor after the week's obligations, so the excess earns yield until it is needed.",
      chainMode: "live",
      day: 0,
      clockMode: "real",
    },
  };
}

function cycleComplete(seq: number): Pick<LedgerEntry, "actor" | "domain" | "action" | "summary" | "detail"> {
  return {
    actor: "system",
    domain: "system",
    action: "cycle_complete",
    summary: "Cycle complete: 6 decisions",
    detail: {
      by: "schedule",
      day: 0,
      clockMode: "real",
      startedAt: at((seq % 100) * 15 - 2),
      finishedAt: at((seq % 100) * 15),
      decisionCount: 6,
      chainMode: "live",
      screeningMode: "live",
      cycleRunId: uuid(`cycle-${seq}`),
    },
  };
}

/** One page of the audit log: `count` entries, newest first, each linked to the one before it. */
export function auditPage(count = 100, firstSeq = 4_201): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const seq = firstSeq + index;
    const kind = seq % 8;
    const body = kind < 4 ? billDecision(seq) : kind < 6 ? screening(seq) : kind === 6 ? treasuryMove(seq) : cycleComplete(seq);
    entries.push({
      seq,
      id: uuid(`entry-${seq}`),
      ts: at(index * 15),
      ...body,
      bodyHash: hex(`body-${seq}`),
      signature: hex(`signature-${seq}`, 128),
      prevHash: hex(`hash-${seq - 1}`),
      hash: hex(`hash-${seq}`),
      signingKeyId: "ledger-key-2026-10",
    });
  }
  return entries.reverse();
}

/** The longest history the insights reads return: 120 of each series, 500 screening checks. */
export function insightsHistory(): InsightsData {
  const runs = Array.from({ length: 120 }, (_, index) => ({
    id: uuid(`run-${index}`),
    startedAt: at(index * 720 - 2),
    finishedAt: at(index * 720),
    durationMs: 41_000 + index * 37,
    decisionCount: 6 + (index % 5),
    paidCount: 3 + (index % 3),
    heldCount: index % 2,
    flaggedCount: index % 7 === 0 ? 1 : 0,
    awaitingInfoCount: index % 4 === 0 ? 1 : 0,
    releasedCount: index % 3 === 0 ? 1 : 0,
    modelDecisionCount: 5 + (index % 4),
    heuristicDecisionCount: index % 3,
    guardrailOverrideCount: index % 9 === 0 ? 1 : 0,
    referenceDisagreementCount: index % 6 === 0 ? 1 : 0,
    status: (index % 23 === 0 ? "partial" : "completed") as "partial" | "completed",
    failedStage: index % 23 === 0 ? "treasury" : null,
    errorMessage: null,
    chainMode: "live" as const,
    screeningMode: "live" as const,
  }));
  const snapshots = runs.map((run, index) => ({
    id: uuid(`snapshot-${index}`),
    cycleRunId: run.id,
    capturedAt: run.finishedAt,
    totalLiquid: 15_000 + Math.sin(index / 6) * 2_400 + index * 13.37,
    openPayables: 4_200 + (index % 11) * 97.5,
    openReceivables: 6_800 - (index % 9) * 120.25,
    obligationsDue7d: 2_100 + (index % 5) * 210.1,
    obligationsDue14d: 3_900 + (index % 7) * 175.3,
    reservePosition: 8_000 + Math.cos(index / 9) * 1_100 + index * 7.11,
    chainMode: "live" as const,
  }));
  const transfers = Array.from({ length: 120 }, (_, index) => ({
    id: uuid(`transfer-${index}`),
    targetType: (index % 4 === 0 ? "milestone" : "invoice") as "milestone" | "invoice",
    targetId: uuid(`target-${index}`),
    txRef: `0x${hex(`transfer-${index}`)}`,
    feeUsd: 0.0029 + (index % 7) * 0.000113,
    feeSource: "chain_reported" as const,
    settledInMs: index % 10 === 0 ? null : 640 + ((index * 53) % 900),
    chain: "ARC",
    providerMode: "live" as const,
    executedAt: at(index * 720 - 1),
    status: "complete",
  }));
  const treasuryMoves = Array.from({ length: 120 }, (_, index) => ({
    id: uuid(`move-${index}`),
    action: (index % 3 === 0 ? "redeem_from_usyc" : "sweep_to_usyc") as "redeem_from_usyc" | "sweep_to_usyc",
    amount: 600 + (index % 5) * 150,
    createdAt: at(index * 720 - 1),
  }));
  const screenings = Array.from({ length: 500 }, (_, index) => {
    const vendor = index % 40;
    return {
      id: uuid(`check-${index}`),
      counterpartyId: uuid(`counterparty-${vendor}`),
      counterpartyName: `${VENDORS[vendor % VENDORS.length]} ${vendor}`,
      riskLevel: index % 37 === 0 ? "medium" : "low",
      previousRiskLevel: index < 40 ? null : "low",
      tierChanged: index >= 40 && index % 37 === 0,
      mode: "live" as const,
      source: "OpenSanctions",
      status: (index % 53 === 0 ? "failed" : "complete") as "failed" | "complete",
      // A sweep checks every payee within a minute or two; sweeps run twice a day.
      createdAt: at(Math.floor(index / 40) * 720 + (index % 40) * 0.05),
    };
  });
  return { transfers, runs, snapshots, treasuryMoves, screenings };
}
