import { CHECKSUM_MISMATCH, checksumMatches } from "@/lib/address-checksum";
import { z } from "zod";
import { LATE_FEE_KINDS } from "@/lib/agent/late-fee";
import type { ApiErrorCode } from "@/lib/api/contract";
import type { OrgRole } from "@/lib/auth/roles";
import type { ClosePackCheckKind, ClosePackOpenState } from "@/lib/close-pack/types";
import type { EvidenceKind, EvidenceStepId } from "@/lib/evidence-chain";
import type { Network } from "@/lib/network";
import type { VerificationMethod } from "@/lib/payee-lock-rules";
import type { ReceiptNotReady } from "@/lib/receipts/facts";
import type { SettlementMismatch } from "@/lib/settlement";
import { COUNTERPARTY_RISK_LEVELS, COUNTERPARTY_ROLES } from "@/lib/api/counterparties";
import { INVOICE_DIRECTIONS } from "@/lib/api/invoices";
import { MILESTONE_STATUSES } from "@/lib/api/milestones";
import { INVOICE_CURRENCIES } from "@/lib/intake-validation";
import { ALL_PAYEE_CHAIN_IDS } from "@/lib/payee-chains";

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
        .enum(["unauthorized", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "unavailable", "internal"] satisfies ApiErrorCode[])
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
        "Payments and yield differ and are reported separately, as in the UI. `unavailable` means nothing can pay in the workspace now: its Circle credentials are stored but could not be read; or it is on Arc mainnet with no Circle account connected yet, or not live yet; or Arc mainnet is switched off on this deployment; or payments are switched off for every workspace, or whether they are could not be read. Cycles refuse to pay then rather than simulate, so neither leg is live or simulated. Yield is also `unavailable` on a network with no yield reserve, such as Arc mainnet."
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
    lateFee: z
      .object({
        kind: z.enum(LATE_FEE_KINDS).describe("`percent_month`, a percent a month of what is still owed, or `fixed`, an amount in `currency`."),
        value: z.number().describe("The percent a month, or the fixed amount."),
        startsOn: z.string().describe("The first day the fee applies, as `YYYY-MM-DD`."),
      })
      .nullable()
      .describe("The late fee a payable carries, if any. The agent weighs it when a bill waits and when cash is short; it is never added to what is paid."),
    decidedAt: z.string().nullable(),
    settledAt: z.string().nullable(),
    escalatedAt: z.string().nullable(),
    agentReasoning: z.string().nullable().describe("Why the agent ruled as it did, verbatim from the decision."),
    txHash: z
      .string()
      .nullable()
      .describe("An on-chain hash once the payment settled, else null: on the workspace's network, or for a payout from a Gateway balance the mint on the payee's chain."),
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
    verificationMethod: z.enum(["unverified", "github", "manual", "seed", "asana"]),
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

// ---------------------------------------------------------------------------
// Request bodies (write API R2). Unknown fields are refused rather than ignored, as unknown filter values are: a typo
// must not quietly drop a field. The console form's own schema then applies its rules on top.

/** A 0x address of 40 hex characters. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const CreateCounterpartyBodySchema = z
  .object({
    name: z.string().describe("2 to 160 characters."),
    role: z.enum(COUNTERPARTY_ROLES).describe("`vendor` or `contractor`, whom the business pays, or `client`, who pays the business."),
    address: z
      .string()
      .regex(EVM_ADDRESS, "Use a 0x address of 40 hex characters")
      // Its capital letters, when it mixes them, must be its EIP-55 checksum (payment safety A1).
      .refine(checksumMatches, CHECKSUM_MISMATCH)
      .optional()
      .describe(
        "Where the agent pays it. An address added through the API waits for a person in the workspace to confirm it on Counterparties; until then the agent pays nothing to it."
      ),
    chain: z
      .enum(ALL_PAYEE_CHAIN_IDS)
      .optional()
      .describe(
        "The chain the address receives on. Defaults to the workspace's own chain: `ARC-TESTNET` on Arc testnet, `ARC` on Arc mainnet. Only a chain the workspace's network pays on is accepted (on Arc mainnet, `BASE` or `ARB` besides its own), and only a vendor can be paid on another chain than the workspace's own."
      ),
    jurisdiction: z.string().optional().describe("Where it is based, up to 80 characters; screening uses it."),
    paymentLimit: z
      .union([z.string(), z.number()])
      .optional()
      .describe("The most the agent pays it in one payment, in USDC, with up to 6 decimal places. Required for a vendor or a contractor."),
    noticeEmail: z.string().optional().describe("Where it is emailed once a payment to it is confirmed."),
  })
  .strict()
  .describe("A counterparty to add. It is screened as one added in the console.");

export const CreateInvoiceBodySchema = z
  .object({
    direction: z
      .enum(INVOICE_DIRECTIONS)
      .optional()
      .describe("`payable`, a bill the business pays, which is the default, or `receivable`, one it is owed."),
    counterpartyId: z
      .string()
      .describe("The counterparty's `id`, from `GET /api/v1/counterparties` or from the answer that added it."),
    amount: z
      .union([z.string(), z.number()])
      .describe("What it bills, in `currency`, with at most 6 decimal places. A decimal string such as `\"1250.50\"` keeps it exact; a number is read the same way."),
    currency: z.enum(INVOICE_CURRENCIES).optional().describe("`USDC`, the default, or `EURC`."),
    dueDate: z.string().describe("The day it is due, as `YYYY-MM-DD`."),
    memo: z.string().optional().describe("What it is for, up to 280 characters."),
    poReference: z.string().optional().describe("The purchase order it bills against, up to 100 characters."),
    goodsReceived: z
      .boolean()
      .optional()
      .describe("Whether what it bills for has arrived. Defaults to `false`. Without it, or without `poReference`, the agent asks for the missing detail instead of paying."),
    earlyPayDiscount: z
      .object({
        percent: z
          .union([z.string(), z.number()])
          .describe("The percent off, greater than 0 and less than 100, with at most 2 decimal places."),
        deadline: z.string().describe("The last day it applies, as `YYYY-MM-DD`, on or before `dueDate`."),
      })
      .strict()
      .optional()
      .describe("A discount for paying by `deadline`. The agent weighs it against what the cash would earn in the reserve until `dueDate`."),
    lateFee: z
      .object({
        kind: z.enum(LATE_FEE_KINDS).describe("`percent_month`, a percent a month of what is still owed, or `fixed`, an amount in `currency`."),
        value: z
          .union([z.string(), z.number()])
          .describe("The percent a month, more than 0 and at most 10, with at most 2 decimal places; or the fixed amount, more than 0 and at most `amount`, with at most 6."),
        startsOn: z.string().optional().describe("The first day the fee applies, as `YYYY-MM-DD`, on or after `dueDate`. Defaults to the day after `dueDate`."),
      })
      .strict()
      .nullable()
      .optional()
      .describe("A late fee the invoice charges once it is paid late, for a payable only. The agent weighs it when a bill waits and when cash is short; it never adds it to what is paid."),
  })
  .strict()
  .describe("An invoice to add. The agent decides a payable as one typed in, with every guardrail, usually within a minute.");

export const CreateMilestoneBodySchema = z
  .object({
    contractorId: z
      .string()
      .describe("The `id` of the contractor or vendor to pay, from `GET /api/v1/counterparties` or from the answer that added it. A client is not paid for milestones."),
    title: z.string().describe("What was delivered, 3 to 160 characters."),
    amount: z
      .union([z.string(), z.number()])
      .describe("What the work is paid, in USDC, with at most 6 decimal places. A decimal string such as `\"250.00\"` keeps it exact; a number is read the same way."),
    verificationSource: z
      .string()
      .optional()
      .describe(
        "A link to the delivered work: https, up to 500 characters. A GitHub pull request (`https://github.com/<owner>/<repo>/pull/<number>`) is checked by the agent, which verifies the milestone once it is merged. Any other link is evidence for the person who verifies the milestone on Contractors."
      ),
  })
  .strict()
  .describe("A milestone to add. It starts pending: the agent pays it only once it is verified, by GitHub or by a person, and only after its own checks.");

export const CreatePayeeLinkBodySchema = z
  .object({
    counterpartyId: z
      .string()
      .describe("The `id` of the vendor or contractor who is to enter the address they are paid at. A client gets no link: the agent never pays one."),
  })
  .strict()
  .describe("Who the link is for.");

export const PayeeLinkSchema = z
  .object({
    id: z.string().describe("The link's own id. It is not the link: that is `url`."),
    counterpartyId: z.string(),
    url: z
      .string()
      .describe("The one-time page where the payee enters their address. It is in this answer only: Vestiarion keeps just its hash. Send it to the payee yourself."),
    expiresAt: z.string().describe("When the link stops working, 7 days after it was made. It also stops once the payee has used it, or a newer link replaces it."),
  })
  .describe("A one-time link for a payee to enter the address they are paid at. That address waits for a person in the workspace to confirm it before the agent pays to it.");

// --- Evidence -------------------------------------------------------------
//
// The workspace's signed files, as its pages download them (evidence API EA10,
// docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md). Each mirrors an interface its
// builder exports, held equal by `tests/api-schemas.test.ts`. Formats and enums are written here as literals and the
// builders are imported as types only: the public `/api/v1/openapi.json` must load no module that reads a workspace's
// data.

const NETWORK_IDS = ["arc-testnet", "arc-mainnet"] as const satisfies readonly Network[];
const EVIDENCE_KINDS = ["checked", "verified", "stated", "inferred", "missing", "unreachable", "contradicted"] as const satisfies readonly EvidenceKind[];
const TOKENS = ["USDC", "EURC"] as const;

const WorkspaceRefSchema = z.object({ slug: z.string(), name: z.string() }).describe("The workspace the document is of.");
const NetworkRefSchema = z
  .object({ id: z.enum(NETWORK_IDS), label: z.string().describe("The network's name, as the workspace's pages write it.") })
  .describe("The workspace's network.");
const SIGNED_ENTRY_PROVES = "What a signed entry proves, and what it does not.";
const CHECK_AN_ENTRY = "How to check one entry alone: its body hash, its signature and its chain hash.";
const KEYS = "The workspace's public keys, active and retired, each under its id: what the entries were signed with.";
const ENTRIES = "Every entry the document cites, oldest first, in full, each with the server's check.";

export const EntryCheckSchema = z
  .union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), reason: z.string() }),
    z.object({ ok: z.null(), reason: z.string() }),
  ])
  .describe("One entry checked alone: `true` it verifies, `false` it does not, `null` it could not be checked here, for example by a key not known here.");

export const OnChainCheckSchema = z
  .union([
    z.object({
      state: z.literal("matches"),
      block: z.number().int().describe("The block the transaction is in."),
      received: z.number().optional().describe("What the payee received, read from the chain's transfer."),
    }),
    z.object({ state: z.literal("mismatch"), reason: z.string() }),
    z.object({ state: z.literal("unreadable") }),
  ])
  .describe("The transaction as its chain records it: it matches the payment, it does not, or the chain could not be read just now.");

export const EvidenceKeySchema = z
  .object({
    id: z.string().describe("The first 16 hex characters of the SHA-256 of the key's public SPKI: a key counts only under this id."),
    status: z.enum(["active", "retired"]),
    publicKeyPem: z.string(),
  })
  .describe("One of the workspace's ledger signing keys, its public half only.");

export const SignedEntrySchema = z
  .object({
    seq: z.number().int(),
    id: z.string().nullable(),
    ts: z.string(),
    actor: z.string(),
    domain: z.string(),
    action: z.string(),
    summary: z.string(),
    detail: z.record(z.string(), z.unknown()),
    body_hash: z.string(),
    signature: z.string(),
    prev_hash: z.string(),
    hash: z.string(),
    signing_key_id: z.string().nullable(),
    check: EntryCheckSchema.nullable().describe("The server's check of this entry alone. A checker re-checks it rather than trust this field."),
  })
  .describe("A ledger entry in full, as the audit export writes it (snake_case), with the server's check.");

const EvidenceLinkSchema = z
  .object({
    href: z.string(),
    label: z.string(),
    state: z.enum(["checked", "not_opened", "unreachable", "contradicted", "cannot_open"]),
    reason: z.string().optional(),
    given: z.literal(true).optional().describe("A link a person, a payee or GitHub gave, rather than one Vestiarion built."),
  })
  .describe("A link a fact points to, and what its check found.");

export const PaymentEvidenceSchema = z
  .object({
    format: z.literal("vestiarion-evidence/1"),
    exportedAt: z.string(),
    workspace: WorkspaceRefSchema,
    network: NetworkRefSchema,
    subject: z
      .object({
        kind: z.enum(["invoice", "milestone"]),
        id: z.string(),
        title: z.string(),
        payee: z.string(),
        amount: z.number().describe("The bill's or the milestone's amount."),
        paidAmount: z
          .number()
          .nullable()
          .describe("What was paid, when an early-payment discount took part of the bill off; null when the whole amount was paid, and for anything not paid."),
        currency: z.string(),
        status: z.string(),
        paid: z.boolean(),
        closed: z.boolean().describe("Rejected by a person, or closed without paying: it will not be paid."),
        simulated: z.boolean().describe("Marked paid by a simulated transfer: nothing moved on chain."),
        onChain: z.boolean().describe("Paid by a transaction on chain the chain shows."),
      })
      .describe("The payable or milestone the evidence is of."),
    labels: z
      .record(z.string(), z.object({ words: z.string(), meaning: z.string(), facts: z.number().int() }))
      .describe("The seven words a fact is labelled with, what each means, and how many facts each holds."),
    steps: z.array(
      z.object({
        id: z.enum(["agreed", "delivered", "bill", "payee", "decision", "people", "payment", "books", "receipt", "signatures"] satisfies EvidenceStepId[]),
        title: z.string(),
        label: z.string().describe("The step's label in words."),
        kind: z.enum(EVIDENCE_KINDS),
        caveat: z.string().optional(),
        facts: z.array(
          z.object({
            label: z.string().describe("The fact's label in words."),
            kind: z.enum(EVIDENCE_KINDS),
            text: z.string(),
            who: z
              .string()
              .nullable()
              .describe('Who stated it: a member by user id, "a former member", "a member" when the members could not be read, "the payee", "@<login> on GitHub" for a GitHub bounty; null when the ledger names no one.'),
            at: z.string().nullable(),
            fill: z.string().optional().describe("For a missing fact: what would fill it."),
            notes: z.array(z.string()).optional(),
            link: EvidenceLinkSchema.optional(),
            warn: z.literal(true).optional().describe("What it says is bad news, however well it is known."),
            entries: z.array(z.number().int()).describe("The signed entries it rests on, by `seq`."),
          })
        ),
      })
    ),
    signedEntryProves: z.string().describe(SIGNED_ENTRY_PROVES),
    checkAnEntry: z.array(z.string()).describe(CHECK_AN_ENTRY),
    keys: z.array(EvidenceKeySchema).describe(KEYS),
    entries: z.array(SignedEntrySchema).describe(ENTRIES),
  })
  .describe(
    "One payable's or milestone's evidence, `vestiarion-evidence/1`: the chain its evidence page shows, each fact citing the signed entries it rests on, which it carries in full."
  );

const ReceiptFactsSchema = z
  .object({
    amount: z.number(),
    token: z.enum(TOKENS),
    paidAt: z.string().describe("When the payment was confirmed."),
    payee: z.string().describe("The address paid."),
    chain: z.string().describe("The chain the payee was paid on."),
    txHash: z.string().describe("The transaction that paid the payee: the transfer on the workspace's network, or the mint on the payee's chain."),
    route: z.enum(["direct", "cctp", "gateway"]),
    sourceTxHash: z.string().optional().describe("CCTP only: the burn on the workspace's network."),
    feeUsdc: z.number().optional().describe("CCTP and Gateway: the route's fee, in USDC."),
    invoiceNumber: z.string().optional().describe("The invoice's own number, as the vendor wrote it."),
    invoiceAmount: z.number().optional().describe("The invoice's amount, only when it was for more than was paid: an early-payment discount."),
    feesPaidBy: z.literal("sender").optional().describe("Who paid the fees: the sender, on top of the amount, and never the payee."),
  })
  .describe("What a receipt states for this payment, as Share receipt would state it now.");

export const PaymentReceiptSchema = z
  .object({
    format: z.literal("vestiarion-receipt/1"),
    exportedAt: z.string(),
    workspace: WorkspaceRefSchema,
    network: NetworkRefSchema,
    invoiceId: z.string(),
    ready: z.boolean().describe("Paid, confirmed, on chain, and a signed entry records its transaction: what Share receipt needs."),
    notReady: z
      .object({
        code: z.enum(["not_payable", "not_paid", "simulated", "not_minted", "no_transaction", "not_recorded"] satisfies ReceiptNotReady[]),
        reason: z.string(),
      })
      .nullable()
      .describe("Why not, when not ready. `simulated` never changes; `not_paid` and `not_minted` pass."),
    facts: ReceiptFactsSchema.nullable(),
    records: z.object({ seq: z.number().int(), hash: z.string() }).nullable().describe("The entry that recorded the transaction; null when not ready."),
    invoiceEntry: z.number().int().nullable().describe("The entry the bill was added with, which its invoice number comes from, or null."),
    shared: z
      .object({
        at: z.string().describe("When a member first shared it."),
        entry: z.number().int().describe("The `receipt_shared` entry that signed the statement the payee saw."),
        linkOpen: z.boolean().describe("Whether its link opens now. The link itself is never in the answer."),
        changes: z.array(z.object({ action: z.enum(["receipt_link_renewed", "receipt_revoked"]), at: z.string(), entry: z.number().int() })),
      })
      .nullable()
      .describe("When a member shared the receipt; null when no one has."),
    checks: z
      .object({
        recorded: EntryCheckSchema.describe("The recording entry checked alone, and holding the transaction."),
        onChain: OnChainCheckSchema,
      })
      .nullable()
      .describe("The receipt's two checks; null when not ready."),
    signedEntryProves: z.string().describe(SIGNED_ENTRY_PROVES),
    checkAnEntry: z.array(z.string()).describe(CHECK_AN_ENTRY),
    keys: z.array(EvidenceKeySchema).describe(KEYS),
    entries: z.array(SignedEntrySchema).describe(ENTRIES),
  })
  .describe("A payable's receipt, `vestiarion-receipt/1`: what it states, the entry that recorded it, its sharing and its checks.");

const PayeeLockSchema = z
  .object({ on: z.boolean(), coolingHours: z.number().describe("Hours a changed address waits before it can be paid; 0 is no wait.") })
  .describe("The payee lock's setting.");
const PayeeLockWhoSchema = z
  .union([
    z.object({ kind: z.literal("member"), userId: z.string(), email: z.string().nullable().describe("Null through the API, which names members by user id only.") }),
    z.object({ kind: z.literal("former_member"), id: z.string().describe("The first 8 characters of their user id.") }),
    z.object({ kind: z.literal("payee_link"), linkId: z.string().nullable() }),
    z.object({ kind: z.literal("github"), login: z.string().nullable() }),
    z.object({ kind: z.literal("unknown") }),
  ])
  .describe("Who did a step.");
const SubjectRefSchema = z.object({ kind: z.enum(["invoice", "milestone"]), id: z.string() });

export const PayeeLockEvidenceSchema = z
  .object({
    format: z.literal("vestiarion-payee-lock-evidence/1"),
    exportedAt: z.string(),
    workspace: WorkspaceRefSchema,
    network: NetworkRefSchema,
    period: z.object({ from: z.string().nullable(), to: z.string().nullable() }).describe("Whole UTC days, `YYYY-MM-DD`; null for an open end."),
    lock: z.object({
      now: PayeeLockSchema,
      changes: z.array(z.object({ at: z.string(), by: PayeeLockWhoSchema, from: PayeeLockSchema.nullable(), to: PayeeLockSchema.nullable(), entry: z.number().int() })),
    }),
    summary: z.object({
      changes: z.number().int(),
      confirmed: z.number().int(),
      confirmedWithRecord: z.number().int(),
      confirmedBySecondPerson: z.number().int(),
      heldWhileUnconfirmed: z.number().int(),
      heldForTheWait: z.number().int(),
      heldAsNewPayee: z.number().int(),
      paid: z.number().int(),
      paidOnlyAfterConfirmation: z.number().int(),
    }),
    changes: z.array(
      z.object({
        counterparty: z.object({ id: z.string(), name: z.string().nullable() }),
        change: z.object({
          at: z.string(),
          from: z.string().nullable(),
          to: z.string().nullable(),
          chain: z.string().nullable(),
          enteredBy: PayeeLockWhoSchema,
          entry: z.number().int(),
        }),
        confirmation: z
          .object({
            at: z.string(),
            by: PayeeLockWhoSchema,
            via: z.string().nullable().describe("With Confirm address (`confirm`), or by approving a payment to it (`approval`)."),
            record: z
              .object({
                method: z.enum(["call", "message", "in_person", "other"] satisfies VerificationMethod[]).nullable(),
                methodLabel: z.string().nullable(),
                contact: z.string().nullable(),
                contactOnFileBefore: z.boolean(),
                note: z.string().nullable(),
              })
              .nullable(),
            secondPerson: z.boolean().nullable(),
            soloConfirmation: z.boolean(),
            byGiver: z.boolean(),
            giverUnknown: z.boolean(),
            waitHours: z.number().nullable(),
            payableFrom: z.string().nullable(),
            lookalikeOf: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
            looksLikeEarlier: z.string().nullable(),
            entry: z.number().int(),
          })
          .nullable(),
        holds: z.array(z.object({ at: z.string(), rule: z.string(), subject: SubjectRefSchema.nullable(), entry: z.number().int() })),
        firstPayment: z
          .object({
            at: z.string(),
            amount: z.number().nullable(),
            currency: z.string(),
            txRef: z.string(),
            txUrl: z.string().nullable(),
            decidedBy: z.enum(["person", "agent"]),
            subject: SubjectRefSchema.nullable(),
            entry: z.number().int(),
          })
          .nullable(),
        checks: z.object({
          recordKept: z.boolean().nullable(),
          contactOnFileBefore: z.boolean().nullable(),
          secondPerson: z.boolean().nullable(),
          paidAfterConfirmation: z.boolean().nullable(),
          paidAfterWait: z.boolean().nullable(),
        }),
      })
    ),
    signedEntryProves: z.string().describe(SIGNED_ENTRY_PROVES),
    checkAnEntry: z.array(z.string()).describe(CHECK_AN_ENTRY),
    keys: z.array(EvidenceKeySchema).describe(KEYS),
    entries: z.array(SignedEntrySchema).describe(ENTRIES),
  })
  .describe("Every payout address change in a period, `vestiarion-payee-lock-evidence/1`, each fact citing the signed entries it rests on.");

const CLOSE_PACK_CHECK_KINDS = [...EVIDENCE_KINDS, "not_applicable"] as const satisfies readonly ClosePackCheckKind[];
const CLOSE_PACK_OPEN_STATES = [
  "settled_later",
  "waiting",
  "in_flight",
  "unknown",
  "gateway_failed",
  "failed",
  "cancelled",
  "not_sent",
  "refunded",
] as const satisfies readonly ClosePackOpenState[];
const DECIMAL = "An amount as text with exactly six decimal places, never a float.";
const ClosePackSourceSchema = z.object({ kind: z.enum(["invoice", "milestone"]), id: z.string() });
const ClosePackWhoSchema = z
  .union([
    z.object({
      kind: z.literal("member"),
      userId: z.string(),
      email: z.string().nullable().describe("Null through the API, which names members by user id only."),
      roleNow: z.enum(["owner", "admin", "approver", "accountant", "viewer"] satisfies OrgRole[]).nullable(),
    }),
    z.object({ kind: z.literal("former_member"), userId: z.string() }),
    z.object({ kind: z.literal("payee_link"), linkId: z.string().nullable() }),
    z.object({ kind: z.literal("github"), login: z.string().nullable() }),
    z.object({ kind: z.literal("unknown") }),
  ])
  .describe("Who did a step.");
const ClosePackCheckSchema = z.object({
  kind: z.enum(CLOSE_PACK_CHECK_KINDS),
  text: z.string(),
  notes: z.array(z.string()),
  at: z.string().nullable(),
  entries: z.array(z.number().int()),
  warn: z.boolean().describe("Bad news, however well it is known."),
});
const ClosePackTotalSchema = z.object({
  token: z.enum(TOKENS),
  payments: z.number().int(),
  amount: z.string().describe(DECIMAL),
  routeFeesUsdc: z.string().describe(DECIMAL),
});

export const ClosePackSchema = z
  .object({
    format: z.literal("vestiarion-close-pack/1"),
    exportedAt: z.string(),
    workspace: WorkspaceRefSchema,
    network: NetworkRefSchema,
    month: z
      .object({
        from: z.string().describe("The first day, `YYYY-MM-DD` (UTC)."),
        to: z.string().describe("The next month's first day: the month runs up to it, not including it."),
        label: z.string(),
        key: z.string().describe("`YYYY-MM`."),
        ended: z.boolean().describe("Whether the month has ended: false for this month so far."),
      })
      .describe("A calendar month in UTC."),
    ledgerHead: z.object({ seq: z.number().int(), hash: z.string() }).nullable().describe("The ledger's newest entry when the pack was read."),
    cut: z.boolean().describe("The month holds more payments than one pack reads (2,000), and the pack stops there."),
    unread: z.array(z.enum(["members", "screening"])).describe("Parts that could not be read just now; the rest shows."),
    totals: z.object({
      onChain: z.array(ClosePackTotalSchema),
      simulated: z.array(ClosePackTotalSchema),
      shadow: z.number().int(),
      notSettled: z.partialRecord(z.enum(CLOSE_PACK_OPEN_STATES), z.number().int()),
      withoutBill: z.number().int(),
      entries: z.object({ cited: z.number().int(), verified: z.number().int(), failed: z.number().int(), unchecked: z.number().int() }),
    }),
    rows: z.array(
      z
        .object({
          paymentId: z.string(),
          source: ClosePackSourceSchema,
          paidAt: z.string(),
          sentAt: z.string(),
          amount: z.string().describe(DECIMAL),
          token: z.enum(TOKENS),
          discount: z.string().nullable(),
          simulated: z.boolean(),
          shadow: z.boolean(),
          payee: z.object({
            counterpartyId: z.string(),
            name: z.string().nullable(),
            address: z.string().nullable(),
            bank: z
              .object({
                provider: z.literal("blindpay"),
                bankCode: z.string().nullable(),
                last4: z.string().nullable(),
                rail: z.string().nullable(),
                receiverAmount: z.string().nullable(),
                receiverCurrency: z.string().nullable(),
                payoutId: z.string().nullable(),
              })
              .nullable(),
          }),
          bill: z.union([
            z.object({
              kind: z.literal("invoice"),
              id: z.string(),
              number: z.string().nullable().describe("The vendor's own number."),
              amount: z.string().describe(DECIMAL),
              currency: z.enum(TOKENS),
              written: z.object({ amount: z.number(), currency: z.string() }).nullable(),
              dueDate: z.string().nullable(),
              poReference: z.string().nullable(),
              memo: z.string().nullable(),
              document: z
                .object({ sha256: z.string(), kind: z.string().nullable() })
                .nullable()
                .describe("The document the bill was read from, by its SHA-256; the document itself is not kept."),
              vendorDocuments: z.array(z.object({ sha256: z.string(), type: z.string().nullable(), at: z.string(), entry: z.number().int() })),
              entry: z.number().int().nullable(),
            }),
            z.object({
              kind: z.literal("milestone"),
              id: z.string(),
              title: z.string(),
              amount: z.string().describe(DECIMAL),
              currency: z.literal("USDC"),
              entry: z.number().int().nullable(),
            }),
          ]),
          approval: z.object({
            authorizedBy: z.enum(["code", "person", "two_people"]).nullable(),
            agent: z
              .object({
                action: z.string(),
                decider: z.string(),
                guardrailRule: z.string().nullable(),
                shadow: z.boolean(),
                at: z.string(),
                entry: z.number().int(),
              })
              .nullable(),
            approvals: z.array(
              z.object({
                who: ClosePackWhoSchema,
                at: z.string(),
                cosign: z.boolean(),
                paid: z.boolean(),
                via: z.string().nullable(),
                entry: z.number().int().nullable(),
              })
            ),
            verdict: z.object({ verdict: z.enum(["agree", "disagree"]), who: ClosePackWhoSchema, at: z.string(), entry: z.number().int() }).nullable(),
            flags: z.object({ soleApprover: z.boolean(), addressGiverApproved: z.boolean(), firstPayment: z.boolean(), fewApprovers: z.boolean() }),
            address: z
              .object({
                address: z.string(),
                mirror: z.boolean(),
                givenBy: ClosePackWhoSchema.nullable(),
                givenAt: z.string().nullable(),
                confirmedBy: ClosePackWhoSchema.nullable(),
                confirmedAt: z.string().nullable(),
                confirmedWith: z.enum(["confirm", "approval"]).nullable(),
                secondPerson: z.boolean().nullable(),
                entries: z.array(z.number().int()),
              })
              .nullable(),
          }),
          checks: z.object({
            guardrails: ClosePackCheckSchema,
            screening: ClosePackCheckSchema,
            walletList: ClosePackCheckSchema,
            payeeLock: ClosePackCheckSchema,
            payTo: ClosePackCheckSchema,
            milestone: ClosePackCheckSchema,
          }),
          transaction: z.object({
            route: z.enum(["direct", "cctp", "gateway", "escrow", "bank", "simulated"]),
            txHash: z.string().nullable(),
            chain: z.string().nullable(),
            chainLabel: z.string().nullable(),
            explorerUrl: z.string().nullable(),
            sourceTxHash: z.string().nullable(),
            sourceExplorerUrl: z.string().nullable(),
            simulatedRef: z.string().nullable(),
            note: z.string().nullable(),
            networkFeeUsd: z.string().nullable(),
            networkFeeSource: z.enum(["chain_reported", "provider_estimate", "simulated_profile"]).nullable(),
            routeFeeUsdc: z.string().nullable(),
            earlierAttempts: z.number().int(),
          }),
          record: z
            .object({
              seq: z.number().int(),
              action: z.string(),
              ts: z.string(),
              hash: z.string(),
              signature: z.string(),
              signingKeyId: z.string().nullable(),
              check: EntryCheckSchema,
            })
            .nullable()
            .describe("The signed entry that records the payment: a copy of its hash and signature, which `entries` carries in full."),
          books: z.object({
            markedPaid: z.boolean(),
            mismatch: z
              .enum(["confirmed_not_marked_paid", "marked_paid_not_confirmed", "marked_paid_other_transaction", "no_signed_entry"] satisfies SettlementMismatch[])
              .nullable(),
            booked: z.object({ tool: z.string(), state: z.string(), paymentId: z.string().nullable(), at: z.string(), entry: z.number().int() }).nullable(),
          }),
          evidencePath: z.string(),
          entries: z.array(z.number().int()).describe("Every entry the row cites, ascending."),
          evidenceUrl: z.string(),
        })
        .describe("A payment settled in the month.")
    ),
    notSettled: z.array(
      z
        .object({
          paymentId: z.string(),
          source: ClosePackSourceSchema,
          payee: z.object({ counterpartyId: z.string(), name: z.string().nullable() }),
          amount: z.string().describe(DECIMAL),
          token: z.enum(TOKENS),
          simulated: z.boolean(),
          state: z.enum(CLOSE_PACK_OPEN_STATES),
          sentAt: z.string().nullable(),
          settledAt: z.string().nullable(),
          reason: z.string().nullable(),
          txHash: z.string().nullable(),
          explorerUrl: z.string().nullable(),
          evidencePath: z.string(),
          evidenceUrl: z.string(),
        })
        .describe("A payment of the month not settled in it.")
    ),
    escrow: z.array(
      z.object({
        kind: z.enum(["funded", "refunded"]),
        at: z.string(),
        milestoneId: z.string(),
        title: z.string().nullable(),
        amount: z.string().describe(DECIMAL),
        txHash: z.string().nullable(),
        explorerUrl: z.string().nullable(),
        entry: z.number().int(),
      })
    ),
    labels: z
      .record(z.enum(CLOSE_PACK_CHECK_KINDS), z.object({ words: z.string(), meaning: z.string() }))
      .describe("Each check kind's words and what it means."),
    signedEntryProves: z.string().describe(SIGNED_ENTRY_PROVES),
    checkAnEntry: z.array(z.string()).describe(CHECK_AN_ENTRY),
    keys: z.array(EvidenceKeySchema).describe(KEYS),
    entries: z.array(SignedEntrySchema).describe(ENTRIES),
  })
  .describe(
    "A month's close pack, `vestiarion-close-pack/1`: every payment settled in it, one row each with its signed entry, the payments not settled, the escrow moves, totals, and every cited entry in full."
  );
