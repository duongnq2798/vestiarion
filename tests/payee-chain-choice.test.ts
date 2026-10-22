import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_MAINNET, ARC_TESTNET, networkProfile } from "@/lib/network";
import { chainChoiceFits, choosablePayeeChains } from "@/lib/payee-chain-choice";

/**
 * Which chains a payee link lets its payee choose among (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md
 * P1, P2): the network's payee chains when there are more than one, and none where the workspace could not pay one of
 * them: from the owner's own wallet, only version 2 of its spending limit contract pays another chain.
 */

const { state, limitMock, chainsOnMock, domainsMock } = vi.hoisted(() => ({
  state: { network: "arc-mainnet" as "arc-mainnet" | "arc-testnet", walletHost: "hosted" as "hosted" | "own" | "external" | null },
  limitMock: vi.fn(),
  chainsOnMock: vi.fn(),
  domainsMock: vi.fn(),
}));
vi.mock("@/lib/spending-limit/onchain", () => ({ contractAllowedDomains: domainsMock }));
vi.mock("@/lib/workspace-network", () => ({ workspaceNetwork: () => networkProfile(state.network) }));
vi.mock("@/lib/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/context")>()),
  currentOrgConfig: () => ({ chain: { walletHost: state.walletHost } }),
}));
vi.mock("@/lib/circle/spending-limit-setup", () => ({ enforcedSpendingLimit: limitMock }));
vi.mock("@/lib/payee-chains", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payee-chains")>();
  return { ...actual, chainsOn: chainsOnMock.mockImplementation(actual.chainsOn) };
});

const ids = async () => (await choosablePayeeChains()).map((chain) => chain.id);
const ENFORCED = { contract: "0x1", agentWalletId: "w", agentAddress: "0x2" };

beforeEach(() => {
  state.network = "arc-mainnet";
  state.walletHost = "hosted";
  limitMock.mockReset().mockResolvedValue(null);
  // Base and Arbitrum: what a version 2 contract deployed on Arc mainnet since Arbitrum joined it names.
  domainsMock.mockReset().mockResolvedValue((1n << 6n) | (1n << 3n));
});

describe("choosablePayeeChains", () => {
  it("offers only the chains a version 2 contract was deployed for, and none while it does not answer (arbitrum mainnet AR3)", async () => {
    state.walletHost = "external";
    limitMock.mockResolvedValue({ ...ENFORCED, version: 2 });
    domainsMock.mockResolvedValueOnce(1n << 6n);
    expect(await ids()).toEqual(["ARC", "BASE"]);
    domainsMock.mockResolvedValueOnce(null);
    expect(await ids()).toEqual([]);
    domainsMock.mockResolvedValueOnce(0n);
    expect(await ids()).toEqual([]);
  });

  it("offers every payee chain of the network to a workspace on its own or a hosted Circle account, reading no contract", async () => {
    expect(await ids()).toEqual(ARC_MAINNET.payeeChains.map((chain) => chain.id));
    state.walletHost = "own";
    state.network = "arc-testnet";
    expect(await ids()).toEqual(ARC_TESTNET.payeeChains.map((chain) => chain.id));
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("offers them from the owner's own wallet only through an enforced version 2 contract", async () => {
    state.walletHost = "external";
    limitMock.mockResolvedValueOnce({ ...ENFORCED, version: 2 });
    expect(await ids()).toEqual(["ARC", "BASE", "ARB"]);
    expect(domainsMock).toHaveBeenCalledWith("0x1");
    limitMock.mockResolvedValueOnce({ ...ENFORCED, version: 1 });
    expect(await ids()).toEqual([]);
    limitMock.mockResolvedValueOnce({ ...ENFORCED });
    expect(await ids()).toEqual([]);
    // No contract carrying the agent's payments: nothing would pay another chain.
    limitMock.mockResolvedValueOnce(null);
    expect(await ids()).toEqual([]);
  });

  it("offers none on a network with one payee chain", async () => {
    chainsOnMock.mockReturnValueOnce([ARC_MAINNET.payeeChains[0]]);
    expect(await ids()).toEqual([]);
  });
});

describe("chainChoiceFits", () => {
  const vendor = { id: "cp-1", role: "vendor", address: null };

  it("fits a vendor with no address that nothing holds to its chain", () => {
    expect(chainChoiceFits(vendor, new Set())).toBe(true);
  });

  it("does not fit a contractor, a payee with an address, or one an open milestone or a bill not in USDC holds", () => {
    expect(chainChoiceFits({ ...vendor, role: "contractor" }, new Set())).toBe(false);
    expect(chainChoiceFits({ ...vendor, address: "0x2222222222222222222222222222222222222222" }, new Set())).toBe(false);
    expect(chainChoiceFits(vendor, new Set(["cp-1"]))).toBe(false);
  });
});
