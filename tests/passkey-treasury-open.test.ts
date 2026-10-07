import { describe, expect, it, vi } from "vitest";
import { getAddress, parseEther, type Hex } from "viem";
import { ARC_MAINNET } from "@/lib/network";
import {
  forgetPendingSetup,
  keepCredential,
  keepPendingSetup,
  keptCredential,
  openPasskeyTreasury,
  passkeyTreasuryFailure,
  pendingSetup,
  type KeptCredential,
} from "@/lib/passkey-treasury";
import type { PasskeySdk } from "@/lib/passkey-wallet";

/**
 * The browser's side of a passkey treasury (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md K2, K6, K8–K10),
 * with the Modular Wallets SDK faked: the wallet opened on Arc mainnet by a new passkey, one used before, or the one this
 * browser kept; another wallet refused by name (Review Focus 3); calls sent as one user operation the wallet pays for;
 * the recovery registered; and what a person is told when any of it fails.
 */

const CONFIG = { clientKey: "LIVE_CLIENT_KEY:abc", clientUrl: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl" };
const SMART = getAddress("0x7a3b5c9d1e2f4a6b8c0d1e2f3a4b5c6d7e8f9a0b");
const AGENT = getAddress("0x5af3107a4000000000000000000000000000a9e7");
const CREDENTIAL = { id: "cred-1", publicKey: "0x04ab" as Hex, rpId: "vestiarion.xyz" };

function fakeSdk(receipt: () => Promise<{ success: boolean; receipt: { transactionHash: string } }> = async () => ({ success: true, receipt: { transactionHash: "0xtx" } })) {
  const calls: Array<[string, unknown]> = [];
  const sent: Array<Record<string, unknown>> = [];
  const note = (name: string, value: unknown) => calls.push([name, value]);
  const sdk: PasskeySdk = {
    chain: { id: ARC_MAINNET.chainId },
    toPasskeyTransport: (url, key) => (note("toPasskeyTransport", { url, key }), { kind: "passkey" }),
    toWebAuthnCredential: async (params) => (note("toWebAuthnCredential", params), { ...CREDENTIAL, raw: { notKept: true } }),
    toModularTransport: (url, key) => (note("toModularTransport", { url, key }), { kind: "modular" }),
    createPublicClient: (params) => (note("createPublicClient", params), { readContract: async () => 1_250_000n }),
    toWebAuthnAccount: (params) => (note("toWebAuthnAccount", params), { kind: "owner" }),
    toCircleSmartAccount: async (params) => (note("toCircleSmartAccount", params), { address: SMART }),
    createBundlerClient: (params) => (
      note("createBundlerClient", params),
      {
        sendUserOperation: async (op) => (sent.push(op as Record<string, unknown>), "0xuserop"),
        waitForUserOperationReceipt: receipt,
      }
    ),
    registerRecoveryAddress: async (params) => (note("registerRecoveryAddress", { recoveryAddress: params.recoveryAddress }), "0xrecoveryop"),
  };
  return { sdk, calls, sent };
}

function store() {
  const items = new Map<string, string>();
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) };
}

describe("openPasskeyTreasury", () => {
  it("creates the passkey and opens its wallet on Arc mainnet, keeping only the passkey's public part", async () => {
    const { sdk, calls } = fakeSdk();
    const treasury = await openPasskeyTreasury({ config: CONFIG, sdk, mode: "Register", username: "own-wallet-co-4f2a9c1e" });
    expect(treasury.address).toBe(SMART);
    expect(treasury.credential).toEqual(CREDENTIAL);
    expect(calls.find(([name]) => name === "toWebAuthnCredential")?.[1]).toMatchObject({ mode: "Register", username: "own-wallet-co-4f2a9c1e" });
    expect(calls.find(([name]) => name === "toModularTransport")?.[1]).toEqual({ url: `${CONFIG.clientUrl}/arc`, key: CONFIG.clientKey });
    expect(await treasury.balance()).toBe(1_250_000n);
  });

  it("signs with the passkey this browser kept, without asking it to log in first (K9)", async () => {
    const { sdk, calls } = fakeSdk();
    const treasury = await openPasskeyTreasury({ config: CONFIG, sdk, mode: "Kept", kept: CREDENTIAL, expected: SMART.toLowerCase() });
    expect(treasury.address).toBe(SMART);
    expect(calls.map(([name]) => name)).not.toContain("toWebAuthnCredential");
    expect(calls.find(([name]) => name === "toWebAuthnAccount")?.[1]).toEqual({ credential: CREDENTIAL });
    await expect(openPasskeyTreasury({ config: CONFIG, sdk, mode: "Kept", kept: null })).rejects.toThrow("No passkey is kept in this browser.");
  });

  it("refuses a passkey that owns another wallet, by name, before anything is signed (Review Focus 3)", async () => {
    const { sdk, sent } = fakeSdk();
    const other = getAddress("0x5af3107a4000000000000000000000000000b0b0");
    await expect(openPasskeyTreasury({ config: CONFIG, sdk, mode: "Login", expected: other })).rejects.toThrow(
      `This passkey owns another wallet (${SMART.slice(0, 6)}…${SMART.slice(-4)}), not this workspace's treasury (${other.slice(0, 6)}…${other.slice(-4)}). Use the passkey you made for it.`
    );
    expect(sent).toEqual([]);
  });

  it("sends calls as one user operation the wallet pays for itself, and says how it ended", async () => {
    const calls = [{ to: AGENT, data: "0x" as Hex, value: parseEther("0.5") }];
    const sentOnce = fakeSdk();
    const treasury = await openPasskeyTreasury({ config: CONFIG, sdk: sentOnce.sdk, mode: "Kept", kept: CREDENTIAL });
    expect(await treasury.send(calls)).toEqual({ kind: "sent", txHash: "0xtx" });
    expect(sentOnce.sent).toEqual([{ calls: [{ to: AGENT, data: "0x", value: parseEther("0.5") }] }]);

    const reverted = fakeSdk(async () => ({ success: false, receipt: { transactionHash: "0xbad" } }));
    expect(await (await openPasskeyTreasury({ config: CONFIG, sdk: reverted.sdk, mode: "Kept", kept: CREDENTIAL })).send(calls)).toEqual({ kind: "reverted", txHash: "0xbad" });

    const silent = fakeSdk(async () => {
      throw new Error("timed out");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await (await openPasskeyTreasury({ config: CONFIG, sdk: silent.sdk, mode: "Kept", kept: CREDENTIAL })).send(calls)).toEqual({ kind: "unconfirmed", userOpHash: "0xuserop" });
    quiet.mockRestore();
  });

  it("registers the recovery address with the passkey, and says how it ended (K8)", async () => {
    const { sdk, calls } = fakeSdk();
    const treasury = await openPasskeyTreasury({ config: CONFIG, sdk, mode: "Kept", kept: CREDENTIAL });
    expect(await treasury.registerRecovery(AGENT)).toEqual({ kind: "sent", txHash: "0xtx" });
    expect(calls.find(([name]) => name === "registerRecoveryAddress")?.[1]).toEqual({ recoveryAddress: AGENT });
  });
});

describe("what the browser keeps for a workspace (K9, K10)", () => {
  it("keeps the passkey's id, public key and relying party, and nothing else", () => {
    const kept = store();
    keepCredential(kept, "own-wallet-co", { ...CREDENTIAL, raw: { notKept: true } });
    expect(keptCredential(kept, "own-wallet-co")).toEqual(CREDENTIAL);
    expect(keptCredential(kept, "another-co")).toBeNull();
    expect(JSON.parse(kept.items.get("vestiarion.passkey-treasury.own-wallet-co") ?? "{}")).toEqual(CREDENTIAL);
  });

  it("reads nothing malformed, and does without storage the browser refuses", () => {
    const kept = store();
    kept.setItem("vestiarion.passkey-treasury.own-wallet-co", "{not json");
    expect(keptCredential(kept, "own-wallet-co")).toBeNull();
    kept.setItem("vestiarion.passkey-treasury.own-wallet-co", JSON.stringify({ id: "", publicKey: "nope" }));
    expect(keptCredential(kept, "own-wallet-co")).toBeNull();
    const refusing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
    expect(() => keepCredential(refusing, "own-wallet-co", CREDENTIAL)).not.toThrow();
    expect(keptCredential(refusing, "own-wallet-co")).toBeNull();
    expect(keptCredential(null, "own-wallet-co")).toBeNull();
  });

  it("keeps a setup sent until it is recorded, so a reload asks about it rather than send it again", () => {
    const kept = store();
    const contract = getAddress("0x5af3107a4000000000000000000000000000e5c0");
    keepPendingSetup(kept, "own-wallet-co", { contract, userOpHash: `0x${"0a".repeat(32)}` });
    expect(pendingSetup(kept, "own-wallet-co")).toEqual({ contract, userOpHash: `0x${"0a".repeat(32)}` });
    forgetPendingSetup(kept, "own-wallet-co");
    expect(pendingSetup(kept, "own-wallet-co")).toBeNull();
  });
});

describe("passkeyTreasuryFailure (K10)", () => {
  const named = (name: string) => Object.assign(new Error("browser"), { name });

  it("says plainly that a cancelled passkey changed nothing, however deep it is wrapped", () => {
    expect(passkeyTreasuryFailure(named("NotAllowedError"), "create")).toBe("No passkey was created. Nothing changed.");
    expect(passkeyTreasuryFailure(new Error("signing failed", { cause: named("NotAllowedError") }), "setup")).toBe("The passkey was not used. Nothing changed.");
  });

  it("names a browser without passkeys, the wrong site, and a wallet short of USDC", () => {
    expect(passkeyTreasuryFailure(named("NotSupportedError"), "create")).toBe(
      "This browser cannot use passkeys. Use one that can, such as Chrome or Safari, or connect a wallet instead."
    );
    expect(passkeyTreasuryFailure(named("SecurityError"), "open")).toBe("Passkeys for Vestiarion wallets work only on www.vestiarion.xyz.");
    expect(passkeyTreasuryFailure(new Error("UserOperation reverted during simulation with reason: AA21 didn't pay prefund"), "setup")).toBe(
      "The wallet does not hold enough USDC for this. Add a little more, then try again. Nothing was sent."
    );
  });

  it("passes its own refusals through, and keeps anything else to the console", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(passkeyTreasuryFailure(new Error("The setup Vestiarion sent is not the one this page expected; nothing was signed."), "setup")).toBe(
      "The setup Vestiarion sent is not the one this page expected; nothing was signed."
    );
    expect(passkeyTreasuryFailure(new Error("socket hang up"), "recovery")).toBe("That did not work. Nothing was sent. Try again in a moment.");
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});

// The kept credential's type is the public part only.
const _typed: KeptCredential = CREDENTIAL;
void _typed;
