import { z } from "zod";
import type { ApiErrorCode } from "@/lib/api/contract";
import { COUNTERPARTY_RISK_LEVELS, COUNTERPARTY_ROLES } from "@/lib/api/counterparties";
import { INVOICE_DIRECTIONS } from "@/lib/api/invoices";
import { MILESTONE_STATUSES } from "@/lib/api/milestones";

/**
 * A Zod schema for every payload `/api/v1` returns.
 *
 * These are what the OpenAPI document and the reference pages are built from.
 * The TypeScript interfaces next to each route stay the source the routes are
 * written against; `tests/api-schemas.test.ts` proves each schema's output type
 * equals its interface, so neither can change without the other.
 *
 * Every `.describe()` becomes a field description on the reference pages, so
 * each one is taken from the interface's own doc comment where it has one.
 */

export const ApiPageSchema = z
  .object({
    nextCursor: z
      .string()
      .nullable()
      .describe("Pass back as `?cursor=` to continue. Null when the end is reached."),
    hasMore: z.boolean().describe("Whether another page follows this one."),
    count: z.number().int().describe("How many items this response carries."),
  })
  .describe("Where this page sits in the collection.");

export const ApiErrorSchema = z
  .object({
    error: z.object({
      code: z
        .enum(["unauthorized", "forbidden", "not_found", "invalid_request", "rate_limited", "unavailable", "internal"] satisfies ApiErrorCode[])
        .describe("One of a closed set, so a client can branch on it without parsing the message."),
      message: z.string().describe("A human-readable explanation. Never carries internal detail."),
    }),
  })
  .describe("Every error the API returns has this shape.");

export const collectionOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), page: ApiPageSchema });
export const resourceOf = <T extends z.ZodType>(item: T) => z.object({ data: item });

// --- Workspace ------------------------------------------------------------

export const StatusSchema = z
  .object({
    businessName: z.string().describe("The workspace's name."),
    provenance: z
      .object({
        payments: z.enum(["live", "simulate", "unavailable"]),
        yield: z.enum(["live", "simulate", "unavailable"]),
        screening: z.enum(["live", "simulate"]),
      })
      .describe(
        "Payments and yield differ and are reported separately, as in the UI. `unavailable` means the workspace's Circle credentials are stored but could not be read: cycles refuse to pay then rather than simulate, so neither leg is live or simulated."
      ),
    clock: z
      .object({
        mode: z.enum(["real", "simulate"]),
        day: z.number(),
        lastCycleAt: z.string().nullable(),
      })
      .describe("The workspace's clock, and when its last cycle ran."),
    totals: z
      .object({
        decisionsLogged: z.number(),
        totalPaidOut: z.number(),
        flagged: z.number(),
      })
      .describe("Running totals across the workspace."),
    configuration: z
      .record(z.string(), z.unknown())
      .describe("What is configured for this workspace, as flags and modes. Never carries a secret."),
    apiVersion: z.literal("v1"),
  })
  .describe("What this workspace is, and what it can actually do.");

// --- Ledger ---------------------------------------------------------------

export const LedgerEntrySchema = z
  .object({
    seq: z.number().describe("Monotonic within a workspace, but not gap-free; the hash chain proves continuity."),
    id: z.string(),
    ts: z.string(),
    actor: z.string(),
    domain: z.string(),
    action: z.string(),
    summary: z.string(),
    detail: z.record(z.string(), z.unknown()),
    bodyHash: z.string().describe("Present so a consumer can verify the chain itself rather than trust us."),
    signature: z.string(),
    prevHash: z.string(),
    hash: z.string(),
    signingKeyId: z
      .string()
      .nullable()
      .describe(
        "Which key signed the entry; `null` for entries written before key identity existed. A consumer verifying for itself needs this to pick the right key."
      ),
  })
  .describe("One entry of the audit chain, which the API returns oldest first.");

export const VerificationResultSchema = z
  .object({
    valid: z
      .boolean()
      .nullable()
      .describe(
        "`true` verified, `false` broken, and `null` not checked, which is a third answer, not a soft failure. A workspace holding no public key has produced no evidence either way."
      ),
    checkedEntries: z.number(),
    brokenAt: z.number().optional().describe("The `seq` of the first entry that failed. Absent unless `valid` is `false`."),
    reason: z.string().optional().describe("Why the verdict is what it is, when it is not a plain `true`."),
    warnings: z
      .array(z.string())
      .optional()
      .describe("Configuration problems found on the way to this verdict; not about the chain."),
  })
  .describe("The verdict of replaying the workspace's ledger: signatures, body hashes and hash continuity.");

// --- Payables and receivables ---------------------------------------------

export const InvoiceSchema = z
  .object({
    id: z.string(),
    direction: z.enum(INVOICE_DIRECTIONS),
    status: z.string(),
    amount: z.number(),
    currency: z.string().describe("USDC or EURC: what `amount` is in, and what a payable is paid in. A EURC payable is checked against the counterparty's USDC limit at a quoted rate."),
    memo: z.string().nullable(),
    poReference: z.string().nullable(),
    goodsReceived: z.boolean(),
    dueDate: z.string(),
    scheduledFor: z.string().nullable().describe("ISO timestamp the agent has committed to pay this on, once scheduled; else null."),
    earlyPayDiscount: z
      .object({ percent: z.number(), deadline: z.string() })
      .nullable()
      .describe("The early-payment discount this invoice carries, if any: the percent off and the deadline's ISO timestamp."),
    decidedAt: z.string().nullable(),
    settledAt: z.string().nullable(),
    escalatedAt: z.string().nullable(),
    agentReasoning: z.string().nullable().describe("Why the agent ruled as it did, verbatim from the decision."),
    txHash: z
      .string()
      .nullable()
      .describe("An on-chain hash once the payment settled, else null: on Arc testnet, or for a payout from a Gateway balance the mint on the payee's chain."),
    paidAmount: z
      .number()
      .nullable()
      .describe("What actually left once this invoice was paid; null otherwise, even while a submitted transfer already carries an amount."),
    counterparty: z.object({ id: z.string(), name: z.string(), riskLevel: z.string() }).nullable(),
    createdAt: z.string(),
  })
  .describe("An invoice in the payable or receivable book, with the agent's reasoning.");

// --- Counterparties -------------------------------------------------------

export const CounterpartySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.enum(COUNTERPARTY_ROLES),
    address: z.string().nullable(),
    chain: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    riskLevel: z.enum(COUNTERPARTY_RISK_LEVELS),
    riskNotes: z.string().nullable(),
    baselinePaymentLimit: z.number().nullable().describe("The business's baseline payment limit for this counterparty."),
    paymentLimit: z.number().nullable().describe("The current payment limit, derived from the risk tier."),
    lastScreenedAt: z.string().nullable(),
    performanceScore: z.number().nullable().describe("No history is different from a zero score and remains null."),
    performanceInputs: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
  })
  .describe("A vendor, client or contractor, with its risk tier and payment limits.");

export const ScreeningHistorySchema = z
  .object({
    id: z.string(),
    riskLevel: z.string(),
    source: z.string(),
    notes: z.string().nullable(),
    rawScore: z.number().nullable(),
    matchedEntityId: z.string().nullable(),
    screeningMode: z.enum(["live", "simulate"]),
    status: z.enum(["complete", "failed"]),
    createdAt: z.string(),
  })
  .describe("One compliance screening of a counterparty.");

export const CounterpartyDetailSchema = CounterpartySchema.extend({
  screeningHistory: z.array(ScreeningHistorySchema).describe("Up to 20 recent screenings, newest first."),
}).describe("A counterparty, with its recent screening history.");

// --- Milestones -----------------------------------------------------------

export const MilestoneSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    amount: z.number(),
    status: z.enum(MILESTONE_STATUSES),
    verificationSource: z.string().nullable(),
    verificationMethod: z.enum(["unverified", "github", "manual", "seed"]),
    verificationStatus: z.enum(["unverified", "verified", "not_merged", "unavailable", "failed"]),
    verificationCheckedAt: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    verificationDetail: z.record(z.string(), z.unknown()),
    verified: z.boolean(),
    decidedAt: z.string().nullable(),
    settledAt: z.string().nullable(),
    closedAt: z.string().nullable().describe("When a person closed the milestone without paying it (status closed), else null."),
    closeReason: z.string().nullable().describe("The reason the person gave for closing it without paying, else null."),
    agentReasoning: z.string().nullable(),
    txHash: z.string().nullable().describe("An on-chain hash when the payment settled on Arc, else null."),
    contractor: z.object({ id: z.string(), name: z.string(), riskLevel: z.string() }).nullable(),
    createdAt: z.string(),
  })
  .describe("A contractor milestone, how it was verified, and whether it was paid.");

// --- Treasury -------------------------------------------------------------

export const TreasurySchema = z
  .object({
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(["operating", "reserve", "chain"]),
        chain: z.string(),
        token: z.string(),
        address: z.string().nullable(),
        balance: z.number(),
        apy: z.number(),
      })
    ),
    reservePosition: z.number().describe("The sum of the reserve accounts' balances."),
    obligations: z
      .object({
        asOf: z.string().nullable(),
        dueWithin7Days: z.number().nullable(),
        dueWithin14Days: z.number().nullable(),
      })
      .describe("From the latest cycle snapshot; null before any snapshot exists, never an invented zero."),
    latestForecast: z
      .object({
        id: z.string(),
        asOf: z.string(),
        horizonDays: z.number(),
        projectedInflow: z.number(),
        projectedOutflow: z.number(),
        liquidBalance: z.number(),
        recommendation: z.string().nullable(),
      })
      .nullable(),
    recentActions: z
      .array(
        z.object({
          id: z.string(),
          action: z.enum(["sweep_to_usyc", "redeem_from_usyc", "rebalance"]),
          amount: z.number(),
          fromAccountId: z.string().nullable(),
          toAccountId: z.string().nullable(),
          reasoning: z.string().nullable(),
          createdAt: z.string(),
        })
      )
      .describe("Up to 20 treasury moves, newest first."),
  })
  .describe("The workspace's accounts, reserve, obligations, latest forecast and recent treasury moves.");

// --- Insights -------------------------------------------------------------

export const TransferTelemetrySchema = z
  .object({
    id: z.string(),
    targetType: z.enum(["invoice", "milestone"]),
    targetId: z.string(),
    txRef: z.string(),
    feeUsd: z.number(),
    feeSource: z.enum(["chain_reported", "provider_estimate", "simulated_profile"]),
    settledInMs: z.number().nullable(),
    chain: z.string(),
    providerMode: z.enum(["live", "simulate"]),
    executedAt: z.string(),
    status: z.string(),
  })
  .describe("One executed payment, with its fee and settlement time.");

export const CycleRunTelemetrySchema = z
  .object({
    id: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number(),
    decisionCount: z.number(),
    paidCount: z.number(),
    heldCount: z.number(),
    flaggedCount: z.number(),
    awaitingInfoCount: z.number(),
    releasedCount: z.number(),
    modelDecisionCount: z.number(),
    heuristicDecisionCount: z.number(),
    guardrailOverrideCount: z.number(),
    referenceDisagreementCount: z
      .number()
      .nullable()
      .describe(
        "Model verdicts that chose a different action from the rule-based policy. Null for cycles run before the comparison existed, never zero, which would claim perfect agreement over decisions never compared."
      ),
    status: z
      .enum(["running", "completed", "partial", "failed"])
      .describe(
        "A cycle that failed partway is not a quiet cycle, and must not read as one. Its counts are real but partial: they cover the stages that ran before it stopped, and nothing after."
      ),
    failedStage: z.string().nullable(),
    errorMessage: z.string().nullable(),
    chainMode: z.enum(["live", "simulate"]),
    screeningMode: z.enum(["live", "simulate"]),
  })
  .describe("One agent cycle: how long it took and what it decided.");

export const CycleSnapshotTelemetrySchema = z
  .object({
    id: z.string(),
    cycleRunId: z.string(),
    capturedAt: z.string(),
    totalLiquid: z.number(),
    openPayables: z.number(),
    openReceivables: z.number(),
    obligationsDue7d: z.number(),
    obligationsDue14d: z.number(),
    reservePosition: z.number(),
    chainMode: z.enum(["live", "simulate"]),
  })
  .describe("The treasury position a cycle captured.");

export const TreasuryMoveTelemetrySchema = z
  .object({
    id: z.string(),
    action: z.enum(["sweep_to_usyc", "redeem_from_usyc", "rebalance"]),
    amount: z.number(),
    createdAt: z.string(),
  })
  .describe("One treasury move.");

export const ScreeningTelemetrySchema = z
  .object({
    id: z.string(),
    counterpartyId: z.string(),
    counterpartyName: z.string(),
    riskLevel: z.string(),
    previousRiskLevel: z.string().nullable(),
    tierChanged: z.boolean(),
    mode: z.enum(["live", "simulate"]),
    source: z.string(),
    status: z.enum(["complete", "failed"]),
    createdAt: z.string(),
  })
  .describe("One compliance screening, and whether it changed the counterparty's risk tier.");

export const InsightsSchema = z
  .object({
    transfers: z.array(TransferTelemetrySchema),
    runs: z.array(CycleRunTelemetrySchema),
    snapshots: z.array(CycleSnapshotTelemetrySchema),
    treasuryMoves: z.array(TreasuryMoveTelemetrySchema),
    screenings: z.array(ScreeningTelemetrySchema),
  })
  .describe(
    "The telemetry behind the Insights charts: the most recent transfers, cycle runs, snapshots, treasury moves and screenings, each oldest first."
  );
