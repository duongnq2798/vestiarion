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
