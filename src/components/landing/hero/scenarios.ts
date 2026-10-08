import type { EvidenceTone } from "../evidence/Evidence";

/**
 * The hero's two replays. The counterparties, amounts and hashes are
 * illustrative, and the hero says so; the stages, the guardrail rule names and
 * the outcome each one produces are the agent's real ones
 * (src/lib/agent/guardrails.ts).
 */
export interface ReplayCheck {
  rule: string;
  passed: boolean;
  note?: string;
}

export interface ReplayScenario {
  id: "paid" | "refused";
  tab: string;
  counterparty: string;
  reference: string;
  amount: string;
  observe: string[];
  model: { action: string; confidence: string; argument: string };
  checks: ReplayCheck[];
  outcome: { tone: EvidenceTone; verdict: string; seal: string; detail: string };
  hash: string;
}

export const SCENARIOS: readonly ReplayScenario[] = [
  {
    id: "paid",
    tab: "Paid",
    counterparty: "Northwind Studio",
    reference: "INV-2291 · milestone 2 of 3",
    amount: "4,200.00",
    observe: ["Screened · no sanctions match", "Milestone verified · pull request merged"],
    model: { action: "PAY", confidence: "0.92", argument: "Matches the contract and the milestone shipped. Due in 3 days." },
    checks: [
      { rule: "invoice.duplicate_of_settled", passed: true },
      { rule: "counterparty.high_risk", passed: true },
      { rule: "counterparty.payment_limit", passed: true, note: "4,200 within the 10,000 USDC limit" },
    ],
    outcome: { tone: "proof", verdict: "Paid", seal: "Signed · Ed25519 · Hash-linked ·", detail: "Settled on Arc" },
    hash: "7b1e04c9a8f2d6135e9b0c47aa21f8d3e6c05b9127f4ad83c1e6b20f9d45c21e",
  },
  {
    id: "refused",
    tab: "Refused by code",
    counterparty: "Halcyon Freight LLC",
    reference: "INV-0931 · rush order",
    amount: "18,000.00",
    observe: ["Screened · tier limit 5,000 USDC", "Marked urgent by the vendor"],
    model: { action: "PAY", confidence: "0.81", argument: "Paying today avoids a late fee on an urgent order." },
    checks: [
      { rule: "invoice.duplicate_of_settled", passed: true },
      { rule: "counterparty.high_risk", passed: true },
      { rule: "counterparty.payment_limit", passed: false, note: "18,000 over the 5,000 USDC limit" },
    ],
    outcome: { tone: "refused", verdict: "Refused", seal: "Refused · Signed · Hash-linked ·", detail: "No funds moved · the model’s argument is kept" },
    hash: "e40a9d17b3c65f82019ce4d7b6a3f05128d9c7e4a1b0f36d5e82c917ab04f6d3",
  },
];

/** When each part of a receipt prints, in ms from the start of a replay. */
export const PRINT_AT = {
  head: 0,
  item: 180,
  observe: 700,
  reason: 1650,
  enforce: 2650,
  check: 260,
  sign: 3750,
  foot: 4200,
} as const;

/** One replay prints for this long, then holds before the next begins. */
export const REPLAY_MS = 4700;
export const HOLD_MS = 3800;
