import type { IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import type { WorkspaceSummary } from "@/components/vx/workspace";
import type { Member, OpenInvitation } from "@/lib/platform/members";
import type { Account, Decision, Forecast } from "@/components/vx/types";
import type { ProvenanceLeg } from "@/components/vx/Provenance";
import type { CounterpartyHistoryInputs } from "@/lib/agent/counterparty-history";
import type { InsightsData } from "@/lib/insights";
import type { LedgerEntry } from "@/lib/ledger";

/**
 * Made-up data for the screens on /design. Typed by the real interfaces, so a
 * change to their shape breaks the build here too. Nothing reads or writes a
 * database: the slugs name no real workspace, and the server actions refuse
 * them without a signed-in member.
 */

export const DESIGN_SLUG = "design-demo";

export const WORKSPACE: WorkspaceSummary = { slug: DESIGN_SLUG, name: "Acme Treasury", mode: "live", role: "owner" };

export const WORKSPACES: WorkspaceSummary[] = [
  WORKSPACE,
  { slug: "design-sandbox", name: "Note One", mode: "sandbox", role: "admin" },
  { slug: "design-studio", name: "Studio Payables", mode: "sandbox", role: "viewer" },
];

export const EMAIL = "ada@example.com";

export const COUNTERPARTIES: IntakeCounterparty[] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Northwind Supply", role: "vendor" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Grace Hopper Studio", role: "contractor" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Contoso Retail", role: "client" },
];

export const MEMBERS: Member[] = [
  { userId: "design-ada", email: EMAIL, role: "owner", joinedAt: "2026-09-24T09:00:00Z" },
  { userId: "design-grace", email: "grace@example.com", role: "admin", joinedAt: "2026-09-27T14:30:00Z" },
  { userId: "design-alan", email: "alan@example.com", role: "viewer", joinedAt: "2026-09-28T08:15:00Z" },
];

export const INVITATIONS: OpenInvitation[] = [
  { id: "design-invite-1", email: "katherine@example.com", role: "approver", expiresAt: "2026-10-05T00:00:00Z" },
  { id: "design-invite-2", email: "edsger@example.com", role: "viewer", expiresAt: "2026-10-06T00:00:00Z" },
];

const reasoning = "Paid INV-204 for 1,250.00 USDC because PO-100 matched, the goods were received on day 26, and Northwind Supply screened clear.";

export const DECISIONS: Decision[] = [
  { id: "design-d1", domain: "ap", action: "Paid", subject: "INV-204 to Northwind Supply", outcome: "settled", amount: 1250, reasoning, decisionMode: "llm", evidence: [{ label: "PO", value: "PO-100", state: "ok" }, { label: "Receipt", value: "day 26", state: "ok" }], txHash: `0x${"7a".repeat(32)}`, auditSeq: 41, at: "2026-09-29T10:15:00Z" },
  { id: "design-d2", domain: "ap", action: "Held", subject: "INV-311 from Contoso Retail", outcome: "held", amount: 4800, reasoning: "Held INV-311: no receipt is recorded for PO-311, so the three-way match is incomplete.", decisionMode: "heuristic", evidence: [{ label: "PO", value: "PO-311", state: "ok" }, { label: "Receipt", value: "missing", state: "missing" }], auditSeq: 42, at: "2026-09-29T10:16:00Z" },
  { id: "design-d3", domain: "ap", action: "Pay", subject: "INV-512 to Grace Hopper Studio", outcome: "refused", amount: 9000, reasoning: "The model argued to pay INV-512 in full on day 27.", decisionMode: "llm", guardrail: { rule: "counterparty.payment_limit", attempted: 9000, limit: 5000, note: "new vendor" }, evidence: [], auditSeq: 43, at: "2026-09-29T10:17:00Z" },
  { id: "design-d4", domain: "treasury", action: "Swept", subject: "2,000.00 USDC into the USYC reserve", outcome: "simulated", amount: 2000, reasoning: "Swept 2,000.00 USDC into USYC because 14-day obligations are covered twice over.", evidence: [], at: "2026-09-29T10:18:00Z" },
  { id: "design-d5", domain: "ar", action: "Scheduled", subject: "a reminder for INV-88 to Contoso Retail", outcome: "scheduled", amount: 3200, reasoning: "Scheduled a reminder: INV-88 is due on day 30 and Contoso Retail paid late once before.", evidence: [], auditSeq: 44, at: "2026-09-29T10:19:00Z" },
  { id: "design-d6", domain: "contractor", action: "Recorded", subject: "milestone 2 for Grace Hopper Studio", outcome: "recorded", reasoning: "Recorded milestone 2 as delivered; pay waits for a person to verify the work.", evidence: [{ label: "PR", value: "gh-pr#12", href: "https://github.com/", state: "neutral" }], at: "2026-09-29T10:20:00Z" },
];

export const ACCOUNTS: Account[] = [
  { id: "design-a1", name: "Operating wallet", chain: "ARC-TESTNET", token: "USDC", balance: 18250.5, apy: null, simulated: false },
  { id: "design-a2", name: "USYC reserve", chain: "ARC-TESTNET", token: "USYC", balance: 5000, apy: 0.045, simulated: true },
];

export const FORECAST: Forecast = { horizonDays: 14, liquid: 18250.5, inflow: 3200, outflow: 24100, recommendation: "Redeem 2,700.00 USDC from the reserve before day 30 to cover INV-512 and INV-311." };

export const PROVENANCE: ProvenanceLeg[] = [
  { label: "Payments", detail: "Arc testnet", live: true },
  { label: "Yield", detail: "USYC reserve", live: false },
  { label: "Screening", detail: "bundled list", live: false },
];

export const HISTORY: CounterpartyHistoryInputs = {
  paidWithoutIntervention: 7,
  informationRequested: 1,
  heldOrFlagged: 2,
  duplicateSubmissions: 0,
  riskTierChanges: 1,
  heldByOurPolicy: 1,
};

const hex = (seed: number) => seed.toString(16).padStart(2, "0").repeat(32);

/** Six linked entries, newest last, the way the ledger writes them. */
export const LEDGER: LedgerEntry[] = [
  ["ap", "ap_pay", "Paid INV-204 to Northwind Supply", { day: 26, decisionMode: "llm", execution: { txRef: `0x${"7a".repeat(32)}` } }],
  ["ap", "hold", "Held INV-311: receipt missing", { day: 26 }],
  ["ap", "ap_pay", "Refused INV-512: above the counterparty limit", { day: 27, guardrailBlocked: true }],
  ["compliance", "compliance_sweep", "Screened 3 counterparties", { day: 27 }],
  ["compliance", "risk_level_changed", "Contoso Retail moved from clear to medium", { day: 27 }],
  ["treasury", "sweep_to_usyc", "Swept 2,000.00 USDC into USYC", { day: 27, earnMode: "simulate" }],
].map(([domain, action, summary, detail], index) => ({
  seq: index + 1,
  id: `design-e${index + 1}`,
  ts: `2026-09-2${index < 2 ? 8 : 9}T1${index}:0${index}:00Z`,
  actor: "agent" as const,
  domain: domain as LedgerEntry["domain"],
  action: action as string,
  summary: summary as string,
  detail: detail as Record<string, unknown>,
  bodyHash: hex(index + 40),
  signature: `${hex(index + 80)}${hex(index + 81)}`.slice(0, 86),
  prevHash: index === 0 ? "0".repeat(64) : hex(index),
  hash: hex(index + 1),
  signingKeyId: null,
}));

export const INSIGHTS: InsightsData = {
  transfers: [
    { id: "design-t1", targetType: "invoice", targetId: "design-i1", txRef: `0x${"7a".repeat(32)}`, feeUsd: 0.0031, feeSource: "chain_reported", settledInMs: 812, chain: "ARC-TESTNET", providerMode: "live", executedAt: "2026-09-28T10:00:00Z", status: "complete" },
    { id: "design-t2", targetType: "milestone", targetId: "design-m1", txRef: `0x${"3c".repeat(32)}`, feeUsd: 0.0027, feeSource: "chain_reported", settledInMs: 640, chain: "ARC-TESTNET", providerMode: "live", executedAt: "2026-09-29T10:00:00Z", status: "complete" },
  ],
  runs: [
    { id: "design-r1", startedAt: "2026-09-28T09:59:00Z", finishedAt: "2026-09-28T10:01:00Z", durationMs: 118000, decisionCount: 5, paidCount: 2, heldCount: 1, flaggedCount: 0, awaitingInfoCount: 1, releasedCount: 1, modelDecisionCount: 3, heuristicDecisionCount: 2, guardrailOverrideCount: 0, referenceDisagreementCount: 0, status: "completed", failedStage: null, errorMessage: null, chainMode: "live", screeningMode: "simulate" },
    { id: "design-r2", startedAt: "2026-09-29T09:59:00Z", finishedAt: "2026-09-29T10:02:00Z", durationMs: 171000, decisionCount: 6, paidCount: 1, heldCount: 2, flaggedCount: 1, awaitingInfoCount: 0, releasedCount: 1, modelDecisionCount: 4, heuristicDecisionCount: 2, guardrailOverrideCount: 1, referenceDisagreementCount: 1, status: "completed", failedStage: null, errorMessage: null, chainMode: "live", screeningMode: "simulate" },
  ],
  snapshots: [
    { id: "design-s1", cycleRunId: "design-r1", capturedAt: "2026-09-28T10:01:00Z", totalLiquid: 21000, openPayables: 14000, openReceivables: 3200, obligationsDue7d: 6000, obligationsDue14d: 14000, reservePosition: 3000, chainMode: "live" },
    { id: "design-s2", cycleRunId: "design-r2", capturedAt: "2026-09-29T10:02:00Z", totalLiquid: 18250.5, openPayables: 13800, openReceivables: 3200, obligationsDue7d: 9000, obligationsDue14d: 24100, reservePosition: 5000, chainMode: "live" },
  ],
  treasuryMoves: [{ id: "design-mv1", action: "sweep_to_usyc", amount: 2000, createdAt: "2026-09-29T10:01:30Z" }],
  screenings: [
    { id: "design-sc1", counterpartyId: COUNTERPARTIES[0].id, counterpartyName: "Northwind Supply", riskLevel: "clear", previousRiskLevel: "clear", tierChanged: false, mode: "simulate", source: "bundled list", status: "complete", createdAt: "2026-09-29T10:00:05Z" },
    { id: "design-sc2", counterpartyId: COUNTERPARTIES[2].id, counterpartyName: "Contoso Retail", riskLevel: "medium", previousRiskLevel: "clear", tierChanged: true, mode: "simulate", source: "bundled list", status: "complete", createdAt: "2026-09-29T10:00:06Z" },
    { id: "design-sc3", counterpartyId: COUNTERPARTIES[1].id, counterpartyName: "Grace Hopper Studio", riskLevel: "clear", previousRiskLevel: null, tierChanged: false, mode: "simulate", source: "bundled list", status: "failed", createdAt: "2026-09-29T10:00:07Z" },
  ],
};
