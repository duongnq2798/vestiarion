import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeMock, lib } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  lib: {
    proofMessage: vi.fn(),
    chooseWalletTreasury: vi.fn(),
    choosePasskeyTreasury: vi.fn(),
    preparePasskeySetup: vi.fn(),
    recordPasskeySetup: vi.fn(),
    recordRecovery: vi.fn(),
    skipRecovery: vi.fn(),
    createAgentWallet: vi.fn(),
    prepareDeployment: vi.fn(),
    recordDeployment: vi.fn(),
    prepareApproval: vi.fn(),
    recordApproval: vi.fn(),
    prepareAgentGas: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/treasury/wallet-treasury", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/treasury/wallet-treasury")>()), ...lib }));

import {
  choosePasskeyTreasuryAction,
  chooseWalletTreasuryAction,
  preparePasskeySetupAction,
  recordPasskeySetupAction,
  recordRecoveryAction,
  skipRecoveryAction,
  createAgentWalletAction,
  prepareAgentGasAction,
  prepareApprovalAction,
  prepareDeploymentAction,
  proofMessageAction,
  recordApprovalAction,
  recordDeploymentAction,
} from "@/app/actions/wallet-treasury";
import { WalletTreasuryError } from "@/lib/treasury/wallet-treasury";

/**
 * The server actions of the wallet treasury's setup (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md W7):
 * owner only, each a step's call with the person's id and address; a refusal comes back as its plain message, and any
 * other failure as one fixed sentence, never the error's own words.
 */

const owner = { ok: true, user: { id: "user-1", email: "owner@example.com" }, membership: { orgId: "org-1", slug: "own-wallet-co", name: "Own Wallet Co", mode: "sandbox", role: "owner" } };
const TX = { to: null, data: "0x6080", value: "0", chainId: 5042 };
const HASH = `0x${"d1".repeat(32)}`;

beforeEach(() => {
  authorizeMock.mockReset();
  for (const fn of Object.values(lib)) fn.mockReset();
});

describe("the wallet treasury's actions", () => {
  it("refuse anyone who may not administer the workspace, and call nothing", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "Only an owner can do that." });
    expect(await createAgentWalletAction("own-wallet-co")).toEqual({ ok: false, message: "Only an owner can do that." });
    expect(await prepareDeploymentAction("own-wallet-co", { dailyUsdc: 20, weeklyUsdc: null })).toEqual({ ok: false, message: "Only an owner can do that.", transaction: null });
    expect(await recordDeploymentAction("own-wallet-co", HASH)).toEqual({ ok: false, message: "Only an owner can do that.", state: null });
    expect(authorizeMock).toHaveBeenCalledWith("own-wallet-co", "org.administer");
    expect(Object.values(lib).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("pass the person and the workspace to each step", async () => {
    authorizeMock.mockResolvedValue(owner);
    lib.proofMessage.mockResolvedValue("Vestiarion: pay from this wallet");
    lib.prepareDeployment.mockResolvedValue(TX);
    lib.recordDeployment.mockResolvedValue("pending");
    lib.prepareApproval.mockResolvedValue({ ...TX, to: "0x3600000000000000000000000000000000000000" });
    lib.recordApproval.mockResolvedValue("verified");
    lib.prepareAgentGas.mockResolvedValue({ ...TX, to: "0xa9e7", data: "0x", value: "500000000000000000" });

    expect(await proofMessageAction("own-wallet-co", "0xb0b0")).toEqual({ ok: true, message: "", text: "Vestiarion: pay from this wallet" });
    expect(lib.proofMessage).toHaveBeenCalledWith({ orgId: "org-1", address: "0xb0b0" });

    expect(await chooseWalletTreasuryAction("own-wallet-co", { address: "0xb0b0", message: "m", signature: "0x51" })).toMatchObject({ ok: true });
    expect(lib.chooseWalletTreasury).toHaveBeenCalledWith({ orgId: "org-1", actorId: "user-1", actorEmail: "owner@example.com", address: "0xb0b0", message: "m", signature: "0x51" });

    expect(await createAgentWalletAction("own-wallet-co")).toMatchObject({ ok: true });
    expect(lib.createAgentWallet).toHaveBeenCalledWith({ orgId: "org-1", actorId: "user-1", actorEmail: "owner@example.com" });

    expect(await prepareDeploymentAction("own-wallet-co", { dailyUsdc: 20, weeklyUsdc: null })).toEqual({ ok: true, message: "", transaction: TX });
    expect(lib.prepareDeployment).toHaveBeenCalledWith({ orgId: "org-1", dailyUsdc: 20, weeklyUsdc: null });
    expect(await recordDeploymentAction("own-wallet-co", HASH)).toEqual({ ok: true, message: "", state: "pending" });
    expect(lib.recordDeployment).toHaveBeenCalledWith({ orgId: "org-1", actorId: "user-1", txHash: HASH });

    expect((await prepareApprovalAction("own-wallet-co", { capUsdc: null })).transaction?.to).toBe("0x3600000000000000000000000000000000000000");
    expect(await recordApprovalAction("own-wallet-co", HASH)).toEqual({ ok: true, message: "", state: "verified" });
    expect((await prepareAgentGasAction("own-wallet-co")).transaction?.value).toBe("500000000000000000");
  });

  it("give a step's refusal in its own words, and anything else as one fixed sentence", async () => {
    authorizeMock.mockResolvedValue(owner);
    lib.prepareDeployment.mockRejectedValueOnce(new WalletTreasuryError("invalid_figures"));
    expect((await prepareDeploymentAction("own-wallet-co", { dailyUsdc: -1, weeklyUsdc: null })).message).toBe(new WalletTreasuryError("invalid_figures").message);
    lib.recordApproval.mockRejectedValueOnce(new Error("rpc https://keyed.example/arc?key=SECRET timed out"));
    const failed = await recordApprovalAction("own-wallet-co", HASH);
    expect(failed).toEqual({ ok: false, message: "Something went wrong; try again.", state: null });
  });

  it("make the agent's wallet with either choice, and keep the choice when Circle cannot (passkey treasury K4)", async () => {
    authorizeMock.mockResolvedValue(owner);
    const person = { orgId: "org-1", actorId: "user-1", actorEmail: "owner@example.com" };
    expect(await choosePasskeyTreasuryAction("own-wallet-co", "0xb0b0")).toEqual({ ok: true, message: "Your passkey wallet is this workspace's treasury." });
    expect(lib.choosePasskeyTreasury).toHaveBeenCalledWith({ ...person, address: "0xb0b0" });
    expect(lib.createAgentWallet).toHaveBeenCalledWith(person);

    expect(await chooseWalletTreasuryAction("own-wallet-co", { address: "0xb0b0", message: "m", signature: "0x51" })).toEqual({
      ok: true,
      message: "Your wallet is this workspace's treasury.",
    });
    expect(lib.createAgentWallet).toHaveBeenCalledTimes(2);

    lib.createAgentWallet.mockRejectedValueOnce(new WalletTreasuryError("agent_failed"));
    expect(await choosePasskeyTreasuryAction("own-wallet-co", "0xb0b0")).toEqual({
      ok: true,
      message: "Your passkey wallet is this workspace's treasury. The agent's wallet was not created yet; create it below.",
    });
  });

  it("pass the person and the workspace to the passkey route's steps", async () => {
    authorizeMock.mockResolvedValue(owner);
    const SETUP = { contract: "0xc0de", salt: "0x01", deployed: false, dailyUnits: "1", weeklyUnits: "2", capUnits: null, calls: [], chainId: 5042 };
    lib.preparePasskeySetup.mockResolvedValue(SETUP);
    lib.recordPasskeySetup.mockResolvedValue("verified");
    lib.recordRecovery.mockResolvedValue("pending");

    expect(await preparePasskeySetupAction("own-wallet-co", { dailyUsdc: 20, weeklyUsdc: null, capUsdc: null })).toEqual({ ok: true, message: "", setup: SETUP });
    expect(lib.preparePasskeySetup).toHaveBeenCalledWith({ orgId: "org-1", dailyUsdc: 20, weeklyUsdc: null, capUsdc: null });
    expect(await recordPasskeySetupAction("own-wallet-co", { txHash: HASH, contract: "0xc0de" })).toEqual({ ok: true, message: "", state: "verified" });
    expect(lib.recordPasskeySetup).toHaveBeenCalledWith({ orgId: "org-1", actorId: "user-1", txHash: HASH, contract: "0xc0de" });
    expect(await recordRecoveryAction("own-wallet-co", { recoveryAddress: "0xbe5c", txHash: HASH })).toEqual({ ok: true, message: "", state: "pending" });
    expect(lib.recordRecovery).toHaveBeenCalledWith({ orgId: "org-1", actorId: "user-1", recoveryAddress: "0xbe5c", txHash: HASH });
    expect(await skipRecoveryAction("own-wallet-co")).toEqual({ ok: true, message: "" });
    expect(lib.skipRecovery).toHaveBeenCalledWith({ orgId: "org-1", actorId: "user-1" });

    authorizeMock.mockResolvedValue({ ok: false, message: "Only an owner can do that." });
    expect(await preparePasskeySetupAction("own-wallet-co", { dailyUsdc: null, weeklyUsdc: null, capUsdc: null })).toEqual({
      ok: false,
      message: "Only an owner can do that.",
      setup: null,
    });
  });

  it("say when a recording step could not read the chain, so the page asks again rather than give up", async () => {
    authorizeMock.mockResolvedValue(owner);
    lib.recordDeployment.mockRejectedValueOnce(new WalletTreasuryError("chain_unreadable"));
    expect(await recordDeploymentAction("own-wallet-co", HASH)).toEqual({
      ok: false,
      message: new WalletTreasuryError("chain_unreadable").message,
      state: null,
      chainUnreadable: true,
    });
    lib.recordApproval.mockRejectedValueOnce(new WalletTreasuryError("chain_unreadable"));
    expect(await recordApprovalAction("own-wallet-co", HASH)).toMatchObject({ ok: false, chainUnreadable: true });
    lib.recordApproval.mockRejectedValueOnce(new WalletTreasuryError("chain_refused", "That approval was not sent from this workspace's wallet."));
    expect(await recordApprovalAction("own-wallet-co", HASH)).toEqual({
      ok: false,
      message: "That approval was not sent from this workspace's wallet.",
      state: null,
    });
  });
});
