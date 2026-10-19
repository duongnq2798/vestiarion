import type { CSSProperties } from "react";
import type { EvidenceTone } from "../evidence/Evidence";

/** A printed line's `--d`: when it prints, for the print utilities in landing-hero.css. Plain, so a server component may use it. */
export function at(ms: number): CSSProperties {
  return { "--d": `${ms}ms` } as CSSProperties;
}

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

/**
 * When each part of the landing's sample bill prints (`BillPreview`, landing motion M4), in ms from the moment it starts:
 * the page's first paint, where the card sits beside the headline; for lines out of sight then, counted from the first
 * of them to come into view (`PrintOnView`). In the order the agent works through the bill: it reads the bill, sets
 * out its reasoning and ticks its four checks one by one, and only then proposes paying it and waits for a person's
 * verdict, as the headline says ("Every bill checked before it's paid"); the next bill is held by a rule in code, and
 * the shield saying so turns amber last. The card's frame and title are there
 * from the start, so it is never an empty box, and every part has finished by 2.5 s (`tests/landing-bill-print.test.tsx`
 * adds each part's length, read from the stylesheet). It never repeats.
 */
export const BILL_PRINT_AT = {
  payee: 120,
  amount: 200,
  reasoning: 380,
  reasoningText: 460,
  checks: [560, 680, 800, 920],
  proposal: 1480,
  waiting: 1540,
  breathe: 1560,
  verdict: 1620,
  next: 1720,
  held: 1960,
  blocked: 2060,
  shield: 2160,
} as const;

/** A check's tick starts to draw this long after its row starts to print, as the next row starts. */
export const BILL_TICK_AFTER = 140;

/** The sample bill has finished printing by now. */
export const BILL_PRINT_MS = 2500;
