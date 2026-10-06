// Generated from the API's OpenAPI document (/api/v1/openapi.json) by `npm run sdk:types`, with
// scripts/lib/sdk-types.ts. Do not edit it by hand: tests/sdk-types.test.ts fails when it differs from what the
// generator renders now.

/** One of a closed set, so a client can branch on it without parsing the message. */
export const API_ERROR_CODES = ["unauthorized", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "unavailable", "internal"] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** What this workspace is, and what it can actually do. */
export interface Status {
  /** The workspace's name. */
  businessName: string;
  /** Payments and yield differ and are reported separately, as in the UI. `unavailable` means nothing can pay in the workspace now: its Circle credentials are stored but could not be read; or it is on Arc mainnet with no Circle account connected yet, or not live yet; or Arc mainnet is switched off on this deployment. Cycles refuse to pay then rather than simulate, so neither leg is live or simulated. Yield is also `unavailable` on a network with no yield reserve, such as Arc mainnet. */
  provenance: {
    payments: "live" | "simulate" | "unavailable";
    yield: "live" | "simulate" | "unavailable";
    screening: "live" | "simulate";
  };
  /** The workspace's clock, and when its last cycle ran. */
  clock: {
    mode: "real" | "simulate";
    day: number;
    lastCycleAt: string | null;
  };
  /** Running totals across the workspace. */
  totals: {
    decisionsLogged: number;
    totalPaidOut: number;
    flagged: number;
  };
  /** What is configured for this workspace, as flags and modes. Never carries a secret. */
  configuration: Record<string, unknown>;
  apiVersion: "v1";
}

/** One entry of the audit chain, which the API returns oldest first. */
export interface LedgerEntry {
  /** Monotonic within a workspace, but not gap-free; the hash chain proves continuity. */
  seq: number;
  id: string;
  ts: string;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  /** Present so a consumer can verify the chain itself rather than trust us. */
  bodyHash: string;
  signature: string;
  prevHash: string;
  hash: string;
  /** Which key signed the entry; `null` for entries written before key identity existed. A consumer verifying for itself needs this to pick the right key. */
  signingKeyId: string | null;
}

/** The verdict of replaying the workspace's ledger: signatures, body hashes and hash continuity. */
export interface LedgerVerification {
  /** `true` verified, `false` broken, and `null` not checked, which is a third answer, not a soft failure. A workspace holding no public key has produced no evidence either way. */
  valid: boolean | null;
  checkedEntries: number;
  /** The `seq` of the first entry that failed. Absent unless `valid` is `false`. */
  brokenAt?: number;
  /** Why the verdict is what it is, when it is not a plain `true`. */
  reason?: string;
  /** Configuration problems found on the way to this verdict; not about the chain. */
  warnings?: Array<string>;
}

/** An invoice in the payable or receivable book, with the agent's reasoning. */
export interface Invoice {
  id: string;
  direction: "payable" | "receivable";
  status: string;
  amount: number;
  /** USDC or EURC: what `amount` is in, and what a payable is paid in. A EURC payable is checked against the counterparty's USDC limit at a quoted rate. */
  currency: string;
  memo: string | null;
  poReference: string | null;
  goodsReceived: boolean;
  dueDate: string;
  /** ISO timestamp the agent has committed to pay this on, once scheduled; else null. */
  scheduledFor: string | null;
  /** The early-payment discount this invoice carries, if any: the percent off and the deadline's ISO timestamp. */
  earlyPayDiscount: {
    percent: number;
    deadline: string;
  } | null;
  decidedAt: string | null;
  settledAt: string | null;
  escalatedAt: string | null;
  /** Why the agent ruled as it did, verbatim from the decision. */
  agentReasoning: string | null;
  /** An on-chain hash once the payment settled, else null: on the workspace's network, or for a payout from a Gateway balance the mint on the payee's chain. */
  txHash: string | null;
  /** What actually left once this invoice was paid; null otherwise, even while a submitted transfer already carries an amount. */
  paidAmount: number | null;
  counterparty: {
    id: string;
    name: string;
    riskLevel: string;
  } | null;
  createdAt: string;
}

/** A vendor, client or contractor, with its risk tier and payment limits. */
export interface Counterparty {
  id: string;
  name: string;
  role: "vendor" | "client" | "contractor";
  address: string | null;
  chain: string | null;
  jurisdiction: string | null;
  riskLevel: "unscreened" | "clear" | "medium" | "high";
  riskNotes: string | null;
  /** The business's baseline payment limit for this counterparty. */
  baselinePaymentLimit: number | null;
  /** The current payment limit, derived from the risk tier. */
  paymentLimit: number | null;
  lastScreenedAt: string | null;
  /** No history is different from a zero score and remains null. */
  performanceScore: number | null;
  performanceInputs: Record<string, unknown> | null;
  createdAt: string;
}

/** A counterparty, with its recent screening history. */
export interface CounterpartyDetail {
  id: string;
  name: string;
  role: "vendor" | "client" | "contractor";
  address: string | null;
  chain: string | null;
  jurisdiction: string | null;
  riskLevel: "unscreened" | "clear" | "medium" | "high";
  riskNotes: string | null;
  /** The business's baseline payment limit for this counterparty. */
  baselinePaymentLimit: number | null;
  /** The current payment limit, derived from the risk tier. */
  paymentLimit: number | null;
  lastScreenedAt: string | null;
  /** No history is different from a zero score and remains null. */
  performanceScore: number | null;
  performanceInputs: Record<string, unknown> | null;
  createdAt: string;
  /** Up to 20 recent screenings, newest first. */
  screeningHistory: Array<{
    id: string;
    riskLevel: string;
    source: string;
    notes: string | null;
    rawScore: number | null;
    matchedEntityId: string | null;
    screeningMode: "live" | "simulate";
    status: "complete" | "failed";
    createdAt: string;
  }>;
}

/** A contractor milestone, how it was verified, and whether it was paid. */
export interface Milestone {
  id: string;
  title: string;
  amount: number;
  status: "pending" | "verified" | "paid" | "held" | "closed";
  verificationSource: string | null;
  verificationMethod: "unverified" | "github" | "manual" | "seed";
  verificationStatus: "unverified" | "verified" | "not_merged" | "unavailable" | "failed";
  verificationCheckedAt: string | null;
  verifiedAt: string | null;
  verificationDetail: Record<string, unknown>;
  verified: boolean;
  decidedAt: string | null;
  settledAt: string | null;
  /** When a person closed the milestone without paying it (status closed), else null. */
  closedAt: string | null;
  /** The reason the person gave for closing it without paying, else null. */
  closeReason: string | null;
  agentReasoning: string | null;
  /** An on-chain hash when the payment settled on Arc, else null. */
  txHash: string | null;
  contractor: {
    id: string;
    name: string;
    riskLevel: string;
  } | null;
  createdAt: string;
}

/** A one-time link for a payee to enter the address they are paid at. That address waits for a person in the workspace to confirm it before the agent pays to it. */
export interface PayeeLink {
  /** The link's own id. It is not the link: that is `url`. */
  id: string;
  counterpartyId: string;
  /** The one-time page where the payee enters their address. It is in this answer only: Vestiarion keeps just its hash. Send it to the payee yourself. */
  url: string;
  /** When the link stops working, 7 days after it was made. It also stops once the payee has used it, or a newer link replaces it. */
  expiresAt: string;
}

/** The workspace's accounts, reserve, obligations, latest forecast and recent treasury moves. */
export interface Treasury {
  accounts: Array<{
    id: string;
    name: string;
    kind: "operating" | "reserve" | "chain";
    chain: string;
    token: string;
    address: string | null;
    balance: number;
    apy: number;
  }>;
  /** The sum of the reserve accounts' balances. */
  reservePosition: number;
  /** From the latest cycle snapshot; null before any snapshot exists, never an invented zero. */
  obligations: {
    asOf: string | null;
    dueWithin7Days: number | null;
    dueWithin14Days: number | null;
  };
  latestForecast: {
    id: string;
    asOf: string;
    horizonDays: number;
    projectedInflow: number;
    projectedOutflow: number;
    liquidBalance: number;
    recommendation: string | null;
  } | null;
  /** Up to 20 treasury moves, newest first. */
  recentActions: Array<{
    id: string;
    action: "sweep_to_usyc" | "redeem_from_usyc" | "rebalance";
    amount: number;
    fromAccountId: string | null;
    toAccountId: string | null;
    reasoning: string | null;
    createdAt: string;
  }>;
}

/** The telemetry behind the Insights charts: the most recent transfers, cycle runs, snapshots, treasury moves and screenings, each oldest first. */
export interface Insights {
  transfers: Array<{
    id: string;
    targetType: "invoice" | "milestone";
    targetId: string;
    txRef: string;
    feeUsd: number;
    feeSource: "chain_reported" | "provider_estimate" | "simulated_profile";
    settledInMs: number | null;
    chain: string;
    providerMode: "live" | "simulate";
    executedAt: string;
    status: string;
  }>;
  runs: Array<{
    id: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    decisionCount: number;
    paidCount: number;
    heldCount: number;
    flaggedCount: number;
    awaitingInfoCount: number;
    releasedCount: number;
    modelDecisionCount: number;
    heuristicDecisionCount: number;
    guardrailOverrideCount: number;
    /** Model verdicts that chose a different action from the rule-based policy. Null for cycles run before the comparison existed, never zero, which would claim perfect agreement over decisions never compared. */
    referenceDisagreementCount: number | null;
    /** A cycle that failed partway is not a quiet cycle, and must not read as one. Its counts are real but partial: they cover the stages that ran before it stopped, and nothing after. */
    status: "running" | "completed" | "partial" | "failed";
    failedStage: string | null;
    errorMessage: string | null;
    chainMode: "live" | "simulate";
    screeningMode: "live" | "simulate";
  }>;
  snapshots: Array<{
    id: string;
    cycleRunId: string;
    capturedAt: string;
    totalLiquid: number;
    openPayables: number;
    openReceivables: number;
    obligationsDue7d: number;
    obligationsDue14d: number;
    reservePosition: number;
    chainMode: "live" | "simulate";
  }>;
  treasuryMoves: Array<{
    id: string;
    action: "sweep_to_usyc" | "redeem_from_usyc" | "rebalance";
    amount: number;
    createdAt: string;
  }>;
  screenings: Array<{
    id: string;
    counterpartyId: string;
    counterpartyName: string;
    riskLevel: string;
    previousRiskLevel: string | null;
    tierChanged: boolean;
    mode: "live" | "simulate";
    source: string;
    status: "complete" | "failed";
    createdAt: string;
  }>;
}

/** Where this page sits in the collection. */
export interface Page {
  /** Pass back as `?cursor=` to continue. Null when the end is reached. */
  nextCursor: string | null;
  /** Whether another page follows this one. */
  hasMore: boolean;
  /** How many items this response carries. */
  count: number;
}

/** An invoice to add. The agent decides a payable as one typed in, with every guardrail, usually within a minute. */
export interface CreateInvoiceInput {
  /** `payable`, a bill the business pays, which is the default, or `receivable`, one it is owed. */
  direction?: "payable" | "receivable";
  /** The counterparty's `id`, from `GET /api/v1/counterparties` or from the answer that added it. */
  counterpartyId: string;
  /** What it bills, in `currency`, with at most 6 decimal places. A decimal string such as `"1250.50"` keeps it exact; a number is read the same way. */
  amount: string | number;
  /** `USDC`, the default, or `EURC`. */
  currency?: "USDC" | "EURC";
  /** The day it is due, as `YYYY-MM-DD`. */
  dueDate: string;
  /** What it is for, up to 280 characters. */
  memo?: string;
  /** The purchase order it bills against, up to 100 characters. */
  poReference?: string;
  /** Whether what it bills for has arrived. Defaults to `false`. Without it, or without `poReference`, the agent asks for the missing detail instead of paying. */
  goodsReceived?: boolean;
  /** A discount for paying by `deadline`. The agent weighs it against what the cash would earn in the reserve until `dueDate`. */
  earlyPayDiscount?: {
    /** The percent off, greater than 0 and less than 100, with at most 2 decimal places. */
    percent: string | number;
    /** The last day it applies, as `YYYY-MM-DD`, on or before `dueDate`. */
    deadline: string;
  };
}

/** A counterparty to add. It is screened as one added in the console. */
export interface CreateCounterpartyInput {
  /** 2 to 160 characters. */
  name: string;
  /** `vendor` or `contractor`, whom the business pays, or `client`, who pays the business. */
  role: "vendor" | "client" | "contractor";
  /** Where the agent pays it. An address added through the API waits for a person in the workspace to confirm it on Counterparties; until then the agent pays nothing to it. */
  address?: string;
  /** The chain the address receives on. Defaults to the workspace's own chain: `ARC-TESTNET` on Arc testnet, `ARC` on Arc mainnet. Only a chain the workspace's network pays on is accepted, and only a vendor can be paid on another chain than the workspace's own. */
  chain?: "ARC-TESTNET" | "BASE-SEPOLIA" | "ARB-SEPOLIA" | "ETH-SEPOLIA" | "ARC";
  /** Where it is based, up to 80 characters; screening uses it. */
  jurisdiction?: string;
  /** The most the agent pays it in one payment, in USDC, with up to 6 decimal places. Required for a vendor or a contractor. */
  paymentLimit?: string | number;
  /** Where it is emailed once a payment to it is confirmed. */
  noticeEmail?: string;
}

/** A milestone to add. It starts pending: the agent pays it only once it is verified, by GitHub or by a person, and only after its own checks. */
export interface CreateMilestoneInput {
  /** The `id` of the contractor or vendor to pay, from `GET /api/v1/counterparties` or from the answer that added it. A client is not paid for milestones. */
  contractorId: string;
  /** What was delivered, 3 to 160 characters. */
  title: string;
  /** What the work is paid, in USDC, with at most 6 decimal places. A decimal string such as `"250.00"` keeps it exact; a number is read the same way. */
  amount: string | number;
  /** A link to the delivered work: https, up to 500 characters. A GitHub pull request (`https://github.com/<owner>/<repo>/pull/<number>`) is checked by the agent, which verifies the milestone once it is merged. Any other link is evidence for the person who verifies the milestone on Contractors. */
  verificationSource?: string;
}

/** Who the link is for. */
export interface CreatePayeeLinkInput {
  /** The `id` of the vendor or contractor who is to enter the address they are paid at. A client gets no link: the agent never pays one. */
  counterpartyId: string;
}

/** The query parameters of `list-ledger-entries`. */
export interface ListLedgerEntriesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only entries in this domain. */
  domain?: string;
  /** Only entries written by this actor. */
  actor?: string;
}

/** The query parameters of `list-invoices`. */
export interface ListInvoicesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only payables, or only receivables. */
  direction?: "payable" | "receivable";
  /** Only invoices in this status. */
  status?: "pending" | "matched" | "scheduled" | "paid" | "held" | "flagged" | "awaiting_info" | "received" | "rejected";
  /** Only invoices from or to this counterparty. */
  counterpartyId?: string;
}

/** The query parameters of `list-counterparties`. */
export interface ListCounterpartiesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only counterparties with this role. */
  role?: "vendor" | "client" | "contractor";
  /** Only counterparties at this risk tier. */
  riskLevel?: "unscreened" | "clear" | "medium" | "high";
}

/** The query parameters of `list-milestones`. */
export interface ListMilestonesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only milestones in this status. */
  status?: "pending" | "verified" | "paid" | "held" | "closed";
  /** Only milestones for this contractor. */
  contractorId?: string;
}
