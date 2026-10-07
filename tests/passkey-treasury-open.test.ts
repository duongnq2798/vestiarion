import { describe, expect, it, vi } from "vitest";
import { getAddress, parseEther, type Hex } from "viem";
import { ARC_MAINNET } from "@/lib/network";
import {
  forgetCredential,
  forgetPendingSetup,
  keepCredential,
  keepPendingSetup,
  keptCredential,
  openPasskeyTreasury,
  passkeyStepView,
  passkeyTreasuryFailure,
  pendingSetup,
  pollRecord,
  settlePasskeySetup,
  type KeptCredential,
  type RecordAnswer,
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
    forgetCredential(kept, "own-wallet-co");
    expect(keptCredential(kept, "own-wallet-co")).toBeNull();
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

describe("settlePasskeySetup (K7, K10; final review I3)", () => {
  const CONTRACT = getAddress("0x5af3107a4000000000000000000000000000e5c0");
  const TX = `0x${"5e".repeat(32)}` as Hex;
  const OP = `0x${"0a".repeat(32)}` as Hex;
  const said: string[] = [];
  const settle = (kept: ReturnType<typeof store>, outcome: Parameters<typeof settlePasskeySetup>[0]["outcome"], record: Parameters<typeof settlePasskeySetup>[0]["record"]) =>
    settlePasskeySetup({ store: kept, orgSlug: "own-wallet-co", contract: CONTRACT, outcome, record, tries: 3, waitMs: 1, sleep: async () => {}, label: "Arc mainnet", say: (text) => said.push(text) });

  it("records a setup the chain shows, and forgets it then", async () => {
    const kept = store();
    expect(await settle(kept, { kind: "sent", txHash: TX }, async () => ({ ok: true, message: "", state: "verified" }))).toBe("verified");
    expect(pendingSetup(kept, "own-wallet-co")).toBeNull();
  });

  it("keeps a setup sent until it is recorded, and never says nothing was sent", async () => {
    const kept = store();
    const unreadable = async () => ({ ok: false, message: "The chain could not be read just now; nothing was recorded. Try again in a moment.", state: null, chainUnreadable: true as const });
    expect(await settle(kept, { kind: "sent", txHash: TX }, unreadable)).toBe("pending");
    expect(pendingSetup(kept, "own-wallet-co")).toEqual({ contract: CONTRACT, txHash: TX });
    expect(said.at(-1)).toBe("The setup was sent. Arc mainnet has not confirmed it yet; reload this page in a minute to check it again. It is not sent twice.");
    expect(await settle(kept, { kind: "unconfirmed", userOpHash: OP }, unreadable)).toBe("pending");
    expect(pendingSetup(kept, "own-wallet-co")).toEqual({ contract: CONTRACT, userOpHash: OP });
  });

  it("keeps a setup whose record call throws, and still says it was sent", async () => {
    const kept = store();
    const offline = async (): Promise<never> => {
      throw new TypeError("Failed to fetch");
    };
    expect(await settle(kept, { kind: "sent", txHash: TX }, offline)).toBe("pending");
    expect(pendingSetup(kept, "own-wallet-co")).toEqual({ contract: CONTRACT, txHash: TX });
    expect(said.at(-1)).toBe("The setup was sent. Arc mainnet has not confirmed it yet; reload this page in a minute to check it again. It is not sent twice.");
  });

  it("forgets a setup the server will never record, and says it was sent", async () => {
    const kept = store();
    const refused = async () => ({ ok: false, message: "The setup failed on chain; nothing was set up.", state: null });
    await expect(settle(kept, { kind: "sent", txHash: TX }, refused)).rejects.toThrow("The setup was sent, but it could not be recorded: The setup failed on chain; nothing was set up.");
    expect(pendingSetup(kept, "own-wallet-co")).toBeNull();
  });

  it("says a reverted setup cost its fee, and forgets it", async () => {
    const kept = store();
    keepPendingSetup(kept, "own-wallet-co", { contract: CONTRACT, userOpHash: OP });
    await expect(settle(kept, { kind: "reverted", txHash: TX }, async () => ({ ok: true, message: "", state: "verified" }))).rejects.toThrow(
      "Arc mainnet did not carry out the setup; nothing was set up, and only its network fee was spent."
    );
    expect(pendingSetup(kept, "own-wallet-co")).toBeNull();
  });
});

describe("pollRecord (final review I3)", () => {
  const poll = (record: () => Promise<RecordAnswer>) => pollRecord({ record, tries: 3, waitMs: 1, sleep: async () => {} });

  it("counts a record call that throws as unread, and asks again", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return { ok: true, message: "", state: "verified" as const };
    };
    expect(await poll(flaky)).toEqual({ state: "verified" });
    expect(calls).toBe(2);
  });

  it("ends unread when every call throws or the chain stays unread", async () => {
    expect(
      await poll(async () => {
        throw new Error("An unexpected response was received from the server.");
      })
    ).toEqual({ state: "unread" });
    expect(await poll(async () => ({ ok: false, message: "The chain could not be read just now.", state: null, chainUnreadable: true as const }))).toEqual({ state: "unread" });
  });

  it("stops at the server's refusal, with its message", async () => {
    let calls = 0;
    const refused = async () => {
      calls += 1;
      return { ok: false, message: "That registration was not sent from this workspace's wallet.", state: null };
    };
    expect(await poll(refused)).toEqual({ state: "refused", message: "That registration was not sent from this workspace's wallet." });
    expect(calls).toBe(1);
  });
});

describe("passkeyStepView (final review I3)", () => {
  it("checks a setup sent before anything else, even where the wallet now holds too little to set up", () => {
    expect(passkeyStepView({ step: "deploy", walletUsdc: 0.1, setupNeedsUsdc: 0.75, pending: true })).toBe("pending");
    expect(passkeyStepView({ step: "deploy", walletUsdc: 0.1, setupNeedsUsdc: 0.75, pending: false })).toBe("fund");
    expect(passkeyStepView({ step: "deploy", walletUsdc: null, setupNeedsUsdc: 0.75, pending: false })).toBe("fund");
    expect(passkeyStepView({ step: "deploy", walletUsdc: 0.75, setupNeedsUsdc: 0.75, pending: false })).toBe("setup");
    expect(passkeyStepView({ step: "approve", walletUsdc: 5, setupNeedsUsdc: 0.75, pending: false })).toBe("setup");
  });

  it("follows the status everywhere else", () => {
    for (const step of ["agent", "gas", "recovery"] as const) expect(passkeyStepView({ step, walletUsdc: 5, setupNeedsUsdc: 0.75, pending: true })).toBe(step);
    expect(passkeyStepView({ step: "ready", walletUsdc: 5, setupNeedsUsdc: 0.75, pending: false })).toBe("none");
  });
});

describe("checking a setup sent before (final review I3)", () => {
  const named = (name: string) => Object.assign(new Error("browser"), { name });

  it("never says nothing was sent when the check itself fails", () => {
    const failed = passkeyTreasuryFailure(new TypeError("Failed to fetch"), "check");
    expect(failed).toBe("The setup could not be checked just now; it is kept and not sent twice. Check again in a moment.");
    expect(failed).not.toMatch(/Nothing was sent/);
  });

  it("still names a passkey that was not used", () => {
    expect(passkeyTreasuryFailure(named("NotAllowedError"), "check")).toBe("The passkey was not used. Nothing changed.");
  });
});

describe("a setup the wallet cannot carry out (final review I2)", () => {
  it("is said to need more USDC, and that nothing was sent", () => {
    expect(passkeyTreasuryFailure(new Error("Execution reverted for an unknown reason. Details: execution reverted"), "setup")).toBe(
      "The wallet could not carry out the setup with what it holds. Add a little more USDC, then try again. Nothing was sent."
    );
  });
});
