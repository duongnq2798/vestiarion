import { describe, expect, it } from "vitest";
import { treasuryDecisionEntries, treasuryLedgerDecision } from "@/components/vx/map";
import type { LedgerEntry } from "@/lib/ledger";

/**
 * The console's treasury decisions are the treasury stage's own: a hold, a sweep or a redemption. Other
 * entries in the treasury domain — a swap of USDC for EURC (EURC swap review #8), a Gateway deposit — are
 * not decisions on the reserve, and are never shown as a simulated hold.
 */

const entry = (seq: number, action: string): LedgerEntry =>
  ({ seq, id: `e${seq}`, ts: "2026-10-01T09:00:00.000Z", actor: "agent", domain: "treasury", action, summary: "", detail: {} }) as unknown as LedgerEntry;

describe("treasuryDecisionEntries", () => {
  it("keeps the treasury stage's decisions, newest first, up to the count asked for", () => {
    const entries = [entry(9, "fx_swap"), entry(8, "hold"), entry(7, "gateway_deposit"), entry(6, "sweep_to_usyc"), entry(5, "redeem_from_usyc")];
    expect(treasuryDecisionEntries(entries, 2).map((e) => e.seq)).toEqual([8, 6]);
  });

  it("is empty when the domain holds no decision", () => {
    expect(treasuryDecisionEntries([entry(3, "fx_swap"), entry(2, "gateway_signer_created")], 2)).toEqual([]);
  });
});

/**
 * A move code bounded (treasury move bounds R3) is shown as what moved, with the model's own ask beside it: the console
 * never shows the 58.1 USDC the model asked for as if it had been redeemed.
 */
describe("treasuryLedgerDecision for a bounded move", () => {
  const bounded = {
    ...entry(1063, "redeem_from_usyc"),
    summary: "Treasury: redeem_from_usyc 0.114999 USDC (code limited the model's redeem_from_usyc of 58.1 USDC)",
    detail: {
      decision: { action: "redeem_from_usyc", amount: 58.1, reasoning: "Restore liquid cash." },
      guardrailBlocked: true,
      guardrailRule: "treasury.redeem_above_need",
      boundedTo: { action: "redeem_from_usyc", amount: 0.114999 },
      earnMode: "live",
      executed: true,
      economics: { idleAboveBuffer: -0.114999, requiredBuffer: 0.114999, expectedHoldDays: 1.68, projectedYieldUsd: 0, roundTripCostUsd: 0.00638 },
    },
  } as unknown as LedgerEntry;

  it("shows the amount that moved, and that code limited the model's", () => {
    const card = treasuryLedgerDecision(bounded);
    expect(card.amount).toBe(0.114999);
    expect(card.evidence).toContainEqual({ label: "Code limited it", value: "the model asked for 58.10 USDC", state: "missing" });
  });

  it("shows a move code turned into a hold as a hold", () => {
    const held = {
      ...bounded,
      detail: { ...(bounded.detail as Record<string, unknown>), guardrailRule: "treasury.sweep_below_buffer", decision: { action: "sweep_to_usyc", amount: 5, reasoning: "x" }, boundedTo: { action: "hold", amount: 0 } },
    } as unknown as LedgerEntry;
    const card = treasuryLedgerDecision(held);
    expect(card.action).toBe("Hold");
    expect(card.amount).toBeUndefined();
  });

  it("shows a move code left alone exactly as before", () => {
    const plain = { ...entry(7, "sweep_to_usyc"), detail: { decision: { action: "sweep_to_usyc", amount: 12, reasoning: "Idle." }, executed: true } } as unknown as LedgerEntry;
    const card = treasuryLedgerDecision(plain);
    expect(card.amount).toBe(12);
    expect(card.evidence.some((item) => item.label === "Code limited it")).toBe(false);
  });
});
