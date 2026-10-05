import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import {
  createPasskeyWallet,
  openPasskeyWallet,
  passkeyFailure,
  passkeyName,
  passkeyWalletConfig,
  passkeyWalletOffered,
  sendProblem,
  usdcUnits,
  usdcText,
  type PasskeySdk,
} from "@/lib/passkey-wallet";

/**
 * A payee with no wallet creates one with a passkey (docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md
 * P1–P7). The module takes the Modular Wallets SDK and viem as parameters, so the order of its calls, its failures and
 * its USDC arithmetic are tested here without a browser or Circle.
 */

const CONFIG = { clientKey: "TEST_CLIENT_KEY:abc", clientUrl: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl" };
const SMART = "0x7a3b5c9d1e2f4a6b8c0d1e2f3a4b5c6d7e8f9a0b";

/** A fake SDK that records each call, in order, with what it was given. */
function fakeSdk(over: Partial<PasskeySdk> = {}) {
  const calls: Array<[string, unknown]> = [];
  const note = (name: string, value: unknown) => calls.push([name, value]);
  const sent: Array<Record<string, unknown>> = [];
  const sdk: PasskeySdk = {
    chain: { id: ARC_TESTNET.chainId },
    toPasskeyTransport: (url, key) => (note("toPasskeyTransport", { url, key }), { kind: "passkey" }),
    toWebAuthnCredential: async (params) => (note("toWebAuthnCredential", params), { id: "cred-1", publicKey: "0xpub" }),
    toModularTransport: (url, key) => (note("toModularTransport", { url, key }), { kind: "modular" }),
    createPublicClient: (params) => (note("createPublicClient", params), { readContract: async () => 12_340_000n }),
    toWebAuthnAccount: (params) => (note("toWebAuthnAccount", params), { kind: "owner" }),
    toCircleSmartAccount: async (params) => (note("toCircleSmartAccount", params), { address: SMART }),
    createBundlerClient: (params) => (
      note("createBundlerClient", params),
      {
        sendUserOperation: async (op: Record<string, unknown>) => (sent.push(op), "0xuserop"),
        waitForUserOperationReceipt: async () => ({ receipt: { transactionHash: "0xtx" } }),
      }
    ),
    ...over,
  };
  return { sdk, calls, sent };
}

describe("when a passkey wallet is offered (P1, P6)", () => {
  it("reads the Modular Wallets client key and URL, and offers nothing without both", () => {
    expect(passkeyWalletConfig({ key: " TEST_CLIENT_KEY:abc ", url: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl/" })).toEqual(CONFIG);
    expect(passkeyWalletConfig({ key: "", url: CONFIG.clientUrl })).toBeNull();
    expect(passkeyWalletConfig({ key: CONFIG.clientKey, url: undefined })).toBeNull();
  });

  it("offers it to a payee paid on Arc testnet only, and only when configured", () => {
    expect(passkeyWalletOffered(ARC_TESTNET.circleBlockchain, CONFIG)).toBe(true);
    expect(passkeyWalletOffered("ARB-SEPOLIA", CONFIG)).toBe(false);
    expect(passkeyWalletOffered(ARC_TESTNET.circleBlockchain, null)).toBe(false);
  });

  it("knows Modular Wallets run on Arc testnet and not yet on Arc mainnet", () => {
    expect(ARC_TESTNET.modularWallets).toEqual({ chain: "arcTestnet" });
    expect(ARC_MAINNET.modularWallets).toBeNull();
  });
});

describe("the passkey's name (P2)", () => {
  it("names the payee and Vestiarion, with a short mark so two payees of one name never collide", () => {
    expect(passkeyName("  Lena   Ortiz ", "4f2a")).toBe("Lena Ortiz (Vestiarion 4f2a)");
    expect(passkeyName("", "4f2a")).toBe("Vestiarion wallet 4f2a");
    expect(passkeyName("x".repeat(80), "4f2a")).toBe(`${"x".repeat(40)} (Vestiarion 4f2a)`);
  });
});

describe("creating a passkey wallet (P2)", () => {
  it("registers a passkey, then works out the smart account it owns on Arc testnet, deploying and paying nothing", async () => {
    const { sdk, calls, sent } = fakeSdk();

    const wallet = await createPasskeyWallet({ config: CONFIG, username: "Lena Ortiz (Vestiarion 4f2a)", sdk });

    expect(wallet).toEqual({ address: SMART });
    expect(calls.map(([name]) => name)).toEqual([
      "toPasskeyTransport",
      "toWebAuthnCredential",
      "toModularTransport",
      "createPublicClient",
      "toWebAuthnAccount",
      "toCircleSmartAccount",
    ]);
    expect(calls[0][1]).toEqual({ url: CONFIG.clientUrl, key: CONFIG.clientKey });
    expect(calls[1][1]).toMatchObject({ mode: "Register", username: "Lena Ortiz (Vestiarion 4f2a)" });
    expect(calls[2][1]).toEqual({ url: `${CONFIG.clientUrl}/arcTestnet`, key: CONFIG.clientKey });
    expect(sent).toEqual([]);
  });
});

describe("opening and spending from a passkey wallet (P4)", () => {
  it("logs in with the passkey, reads its USDC, and sends USDC as a user operation whose gas Circle Gas Station pays", async () => {
    const { sdk, calls, sent } = fakeSdk();

    const wallet = await openPasskeyWallet({ config: CONFIG, sdk });

    expect(wallet.address).toBe(SMART);
    expect(calls[1][1]).toMatchObject({ mode: "Login" });
    expect(await wallet.balance()).toBe(12_340_000n);

    const to = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
    expect(await wallet.send(to, 1_500_000n)).toBe("0xtx");
    expect(sent).toHaveLength(1);
    expect(sent[0].paymaster).toBe(true);
    const [call] = sent[0].calls as Array<{ to: string; data: `0x${string}` }>;
    expect(call.to).toBe(ARC_TESTNET.tokens.USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data })).toEqual({ functionName: "transfer", args: [to, 1_500_000n] });
  });
});

describe("USDC amounts, in six decimals", () => {
  it("reads what a person types, refusing what cannot be sent", () => {
    expect(usdcUnits("1.5")).toBe(1_500_000n);
    expect(usdcUnits(" 0.000001 ")).toBe(1n);
    expect(usdcUnits("12")).toBe(12_000_000n);
    for (const bad of ["", "0", "0.0000001", "-1", "1,5", "abc", "1e3"]) expect(usdcUnits(bad)).toBeNull();
  });

  it("shows units as USDC", () => {
    expect(usdcText(12_340_000n)).toBe("12.34");
    expect(usdcText(1n)).toBe("0.000001");
    expect(usdcText(0n)).toBe("0.00");
  });

  it("checks a send before the passkey is asked: the address, its checksum, and an amount the wallet holds", () => {
    const to = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
    expect(sendProblem({ to, amount: "1.5", balance: 2_000_000n, from: SMART })).toBeNull();
    expect(sendProblem({ to: "0x123", amount: "1.5", balance: 2_000_000n, from: SMART })).toBe(
      "That doesn't look like a wallet address. It starts with 0x and has 42 characters in all."
    );
    expect(sendProblem({ to: "0x840DE234Bfc3F66fA380888A0a8204D9487D60d4", amount: "1.5", balance: 2_000_000n, from: SMART })).toMatch(/checksum/);
    expect(sendProblem({ to, amount: "0", balance: 2_000_000n, from: SMART })).toBe("Enter an amount of USDC, such as 1.50.");
    expect(sendProblem({ to, amount: "3", balance: 2_000_000n, from: SMART })).toBe("This wallet holds 2.00 USDC.");
    expect(sendProblem({ to: SMART, amount: "1", balance: 2_000_000n, from: SMART })).toBe("That is this wallet's own address.");
  });
});

describe("what a person is told when it fails (P5)", () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("says a cancelled or timed-out passkey changed nothing", () => {
    expect(passkeyFailure(named("NotAllowedError"), "create")).toBe("No passkey was created. Nothing changed.");
    expect(passkeyFailure(named("NotAllowedError"), "open")).toBe("The passkey was not used. Nothing changed.");
    expect(passkeyFailure(named("NotAllowedError"), "send")).toBe("The passkey was not used. Nothing was sent.");
  });

  it("points a browser without passkeys to another wallet", () => {
    expect(passkeyFailure(named("NotSupportedError"), "create")).toBe("This browser cannot create passkeys. Enter an address from another wallet instead.");
  });

  it("says anything else plainly, and logs the error rather than showing it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(passkeyFailure(new Error("rpc 500"), "create")).toBe("That did not work. Try again in a moment, or enter an address from another wallet.");
    expect(passkeyFailure(new Error("rpc 500"), "send")).toBe("Nothing was sent. Try again in a moment.");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
