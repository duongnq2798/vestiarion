import { describe, expect, it } from "vitest";
import { treasuryDecisionEntries } from "@/components/vx/map";
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
