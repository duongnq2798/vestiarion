import { describe, expect, it, vi } from "vitest";
import { onChainLimitGate } from "@/lib/agent/onchain-limit";
import { spendingLimitRef } from "@/lib/spending-limit/onchain";

/**
 * The spending limit on Arc as one cycle sees it (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * R3, R4, R7): read once, then for each payment the agent would make, whether the contract can carry it and, when it
 * can, the contract's verdict and what to send it through.
 */

const ENFORCED = { contract: "0x11a1700000000000000000000000000000001111", agentWalletId: "wallet-agent", agentAddress: "0xA9e7000000000000000000000000000000000A9e" };
const PAYEE = "0x19801dAA2F1E5E5e707b7E57Ff664f3d27fFdd12";

describe("onChainLimitGate", () => {
  it("says nothing at all when the workspace does not enforce its limit on Arc", async () => {
    const verdict = vi.fn();
    const gate = onChainLimitGate({ read: async () => null, verdict });
    expect(await gate.check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 1 })).toBeNull();
    expect(verdict).not.toHaveBeenCalled();
  });

  it("asks the contract about a USDC payment on Arc, and names what to send it through", async () => {
    const verdict = vi.fn(async () => ({ state: "allowed" as const }));
    const gate = onChainLimitGate({ read: async () => ENFORCED, verdict });
    const check = await gate.check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 1.2 });
    const ref = spendingLimitRef("invoice", "inv-1");
    expect(verdict).toHaveBeenCalledWith({ contract: ENFORCED.contract, agent: ENFORCED.agentAddress, to: PAYEE, amount: 1.2, ref });
    expect(check).toEqual({
      contract: ENFORCED.contract,
      agent: ENFORCED.agentAddress,
      ref,
      covered: true,
      verdict: { state: "allowed" },
      payment: { contract: ENFORCED.contract, agentWalletId: ENFORCED.agentWalletId, ref },
    });
  });

  it("marks a EURC payment, or one to another chain, as one the contract cannot carry, without asking it", async () => {
    const verdict = vi.fn();
    const gate = onChainLimitGate({ read: async () => ENFORCED, verdict });
    expect(await gate.check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 1, currency: "EURC" })).toMatchObject({
      covered: false,
      uncoveredBecause: "eurc",
      verdict: null,
      payment: null,
    });
    expect(await gate.check({ sourceType: "invoice", sourceId: "inv-2", to: PAYEE, amount: 1, destinationChain: "BASE-SEPOLIA" })).toMatchObject({
      covered: false,
      uncoveredBecause: "another_chain",
      payment: null,
    });
    expect(verdict).not.toHaveBeenCalled();
  });

  it("does not ask about a payee with no address yet, but still sends through the contract", async () => {
    const verdict = vi.fn();
    const gate = onChainLimitGate({ read: async () => ENFORCED, verdict });
    expect(await gate.check({ sourceType: "milestone", sourceId: "m-1", to: null, amount: 1 })).toMatchObject({ covered: true, verdict: null, payment: { agentWalletId: "wallet-agent" } });
    expect(verdict).not.toHaveBeenCalled();
  });

  it("reads the workspace's setting once, however many payments it is asked about", async () => {
    const read = vi.fn(async () => ENFORCED);
    const gate = onChainLimitGate({ read, verdict: async () => ({ state: "allowed" as const }) });
    await gate.check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 1 });
    await gate.check({ sourceType: "invoice", sourceId: "inv-2", to: PAYEE, amount: 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("onChainLimitGate with a version 2 contract (spending limit v2 V12)", () => {
  const V2 = { ...ENFORCED, version: 2 as const };
  const FEE = { maxFeeUnits: 54_000n, domain: 6 };

  it("covers a payout to another chain, asking the contract's payAcrossChains with the fee read for the decision", async () => {
    const verdict = vi.fn();
    const crossChainVerdict = vi.fn(async () => ({ state: "allowed" as const }));
    const gate = onChainLimitGate({ read: async () => V2, verdict, crossChainVerdict });
    const ref = spendingLimitRef("invoice", "inv-1");
    const check = await gate.check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 25, destinationChain: "BASE", bridgeFee: FEE });
    expect(crossChainVerdict).toHaveBeenCalledWith({ contract: V2.contract, agent: V2.agentAddress, recipient: PAYEE, amount: 25, maxFeeUnits: 54_000n, domain: 6, ref });
    expect(verdict).not.toHaveBeenCalled();
    expect(check).toEqual({
      contract: V2.contract,
      agent: V2.agentAddress,
      ref,
      covered: true,
      verdict: { state: "allowed" },
      payment: { contract: V2.contract, agentWalletId: V2.agentWalletId, ref, version: 2 },
    });
  });

  it("carries the contract's refusal past a figure, the fee counted, so the bill is held with its figures", async () => {
    const refused = { state: "refused" as const, error: "OverDailyLimit", spent: 40, amount: 10.054, limit: 50 };
    const gate = onChainLimitGate({ read: async () => V2, crossChainVerdict: vi.fn(async () => refused) });
    expect(await gate.check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 10, destinationChain: "BASE", bridgeFee: FEE })).toMatchObject({ covered: true, verdict: refused });
  });

  it("asks nothing without a fee, which the bridge guardrail holds, and still names what to send it through", async () => {
    const crossChainVerdict = vi.fn();
    const gate = onChainLimitGate({ read: async () => V2, crossChainVerdict });
    expect(await gate.check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 1, destinationChain: "BASE", bridgeFee: null })).toMatchObject({
      covered: true,
      verdict: null,
      payment: { version: 2 },
    });
    expect(crossChainVerdict).not.toHaveBeenCalled();
  });

  it("still cannot carry EURC; version 1 still cannot carry another chain", async () => {
    expect(await onChainLimitGate({ read: async () => V2 }).check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 1, currency: "EURC", destinationChain: "BASE" })).toMatchObject({
      covered: false,
      uncoveredBecause: "eurc",
    });
    expect(await onChainLimitGate({ read: async () => ({ ...ENFORCED, version: 1 as const }) }).check({ sourceType: "invoice", sourceId: "inv-1", to: PAYEE, amount: 1, destinationChain: "BASE", bridgeFee: FEE })).toMatchObject({
      covered: false,
      uncoveredBecause: "another_chain",
    });
  });
});
