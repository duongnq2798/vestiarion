import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import { passkeyFailure, passkeyMark, passkeyName, passkeyWalletAddress, passkeyWalletConfig, passkeyWalletOffered, type PasskeySdk } from "@/lib/passkey-wallet";
import { openPasskeyWallet, sendProblem, transferCall, usdcText, usdcUnits } from "@/lib/passkey-wallet-send";

/**
 * A payee with no wallet creates one with a passkey (docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md
 * P1–P7). The modules take the Modular Wallets SDK and viem as parameters, so the order of their calls, their failures
 * and their USDC arithmetic are tested here without a browser or Circle; tests/passkey-wallet-sdk.test.ts runs the real
 * binding against a faked browser and network.
 */

const CONFIG = { clientKey: "TEST_CLIENT_KEY:abc", clientUrl: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl" };
const SMART = "0x7a3b5c9d1e2f4a6b8c0d1e2f3a4b5c6d7e8f9a0b";
const TO = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";

/** A fake SDK that records each call, in order, with what it was given. */
function fakeSdk(over: Partial<PasskeySdk> = {}, receipt: () => Promise<{ success: boolean; receipt: { transactionHash: string } }> = async () => ({ success: true, receipt: { transactionHash: "0xtx" } })) {
  const calls: Array<[string, unknown]> = [];
  const note = (name: string, value: unknown) => calls.push([name, value]);
  const sent: Array<Record<string, unknown>> = [];
  const sdk: PasskeySdk = {
    chain: { id: ARC_TESTNET.chainId },
    toPasskeyTransport: (url, key) => (note("toPasskeyTransport", { url, key }), { kind: "passkey" }),
    toWebAuthnCredential: async (params) => (note("toWebAuthnCredential", params), { id: "cred-1", publicKey: "0xpub", rpId: "vestiarion.xyz" }),
    toModularTransport: (url, key) => (note("toModularTransport", { url, key }), { kind: "modular" }),
    createPublicClient: (params) => (note("createPublicClient", params), { readContract: async () => 12_340_000n }),
    toWebAuthnAccount: (params) => (note("toWebAuthnAccount", params), { kind: "owner" }),
    toCircleSmartAccount: async (params) => (note("toCircleSmartAccount", params), { address: SMART }),
    createBundlerClient: (params) => (
      note("createBundlerClient", params),
      {
        sendUserOperation: async (op) => (sent.push(op as Record<string, unknown>), "0xuserop"),
        waitForUserOperationReceipt: receipt,
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

  it("keeps viem out of what the payee link loads: only its types are imported (review finding 6)", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "lib", "passkey-wallet.ts"), "utf8");
    expect(source).not.toMatch(/^import (?!type )[^;]*from "viem/m);
  });
});

describe("the passkey's name (P2)", () => {
  /** Circle's rule for a passkey's username, as its registration answered on 2026-10-05 (-32025). */
  const CIRCLE_USERNAME = /^[A-Za-z0-9_@.:+-]{5,50}$/;

  it("names the business that pays, then a mark, in letters Circle accepts, and not the payee (review finding 7)", () => {
    expect(passkeyName("  Northstar   Studio ", "4f2a9c1e")).toBe("Northstar-Studio-4f2a9c1e");
    expect(passkeyName("testnet-2", "4f2a9c1e")).toBe("testnet-2-4f2a9c1e");
    expect(passkeyName("Công ty Đất Việt", "4f2a9c1e")).toBe("Cong-ty-Dat-Viet-4f2a9c1e");
    expect(passkeyName("Tom's Café & Co.", "4f2a9c1e")).toBe("Toms-Cafe-Co-4f2a9c1e");
    expect(passkeyName("Straße Øst", "4f2a9c1e")).toBe("Strasse-Ost-4f2a9c1e");
    expect(passkeyName("", "4f2a9c1e")).toBe("Vestiarion-4f2a9c1e");
    expect(passkeyName("北京工作室", "4f2a9c1e")).toBe("Vestiarion-4f2a9c1e");
    expect(passkeyName("x".repeat(80), "4f2a9c1e")).toBe(`${"x".repeat(32)}-4f2a9c1e`);
  });

  it("gives Circle a name it accepts whatever the business is called: 5 to 50 letters, digits and _@.:+-", () => {
    const businesses = ["testnet-2 (Vestiarion)", "A", `${"a".repeat(31)} b`, "Ünïcødé GmbH", "🙂 Studio", "...", "-x-", "Acme, Inc.", "A&B / C", " ", "Đ"];
    for (const business of businesses) expect(passkeyName(business, passkeyMark())).toMatch(CIRCLE_USERNAME);
  });

  it("marks each attempt afresh with eight hex characters: Circle keeps a name once asked, used or not (-32024)", () => {
    const marks = new Set(Array.from({ length: 50 }, () => passkeyMark()));
    expect(marks.size).toBe(50);
    for (const mark of marks) expect(mark).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("the wallet's address from a payee link (P2)", () => {
  it("registers a passkey, then works out the smart account it owns on Arc testnet, deploying and paying nothing", async () => {
    const { sdk, calls, sent } = fakeSdk();

    const wallet = await passkeyWalletAddress({ config: CONFIG, mode: "Register", username: "Northstar (Vestiarion 4f2a)", sdk });

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
    expect(calls[1][1]).toMatchObject({ mode: "Register", username: "Northstar (Vestiarion 4f2a)" });
    expect(calls[2][1]).toEqual({ url: `${CONFIG.clientUrl}/arcTestnet`, key: CONFIG.clientKey });
    expect(sent).toEqual([]);
  });

  it("uses a passkey wallet the payee made before, by logging in rather than registering another (review finding 7)", async () => {
    const { sdk, calls } = fakeSdk();
    expect(await passkeyWalletAddress({ config: CONFIG, mode: "Login", sdk })).toEqual({ address: SMART });
    expect(calls[1][1]).toMatchObject({ mode: "Login" });
    expect(calls[1][1]).not.toHaveProperty("username");
  });
});

describe("opening and spending from a passkey wallet (P4)", () => {
  it("logs in with the passkey, reads its USDC, and sends USDC as a user operation whose gas Circle Gas Station pays", async () => {
    const { sdk, calls, sent } = fakeSdk();

    const wallet = await openPasskeyWallet({ config: CONFIG, sdk });

    expect(wallet.address).toBe(SMART);
    expect(calls[1][1]).toMatchObject({ mode: "Login" });
    expect(await wallet.balance()).toBe(12_340_000n);

    expect(await wallet.send(TO, 1_500_000n)).toEqual({ kind: "sent", txHash: "0xtx" });
    expect(sent).toHaveLength(1);
    expect(sent[0].paymaster).toBe(true);
    const [call] = sent[0].calls as Array<{ to: string; data: `0x${string}` }>;
    expect(call.to).toBe(ARC_TESTNET.tokens.USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data })).toEqual({ functionName: "transfer", args: [TO, 1_500_000n] });
  });

  it("says a transfer Arc testnet reverted moved nothing, rather than that it was sent (review finding 1)", async () => {
    const { sdk } = fakeSdk({}, async () => ({ success: false, receipt: { transactionHash: "0xreverted" } }));
    const wallet = await openPasskeyWallet({ config: CONFIG, sdk });
    expect(await wallet.send(TO, 1_500_000n)).toEqual({ kind: "reverted", txHash: "0xreverted" });
  });

  it("never says nothing was sent once Circle took the user operation, though its receipt could not be read (review finding 1)", async () => {
    const { sdk } = fakeSdk({}, async () => {
      throw new Error("Timed out while waiting for User Operation with hash 0xuserop");
    });
    const wallet = await openPasskeyWallet({ config: CONFIG, sdk });
    expect(await wallet.send(TO, 1_500_000n)).toEqual({ kind: "unconfirmed", userOpHash: "0xuserop" });
  });

  it("throws when Circle never took it, which the page reports as nothing sent", async () => {
    const { sdk } = fakeSdk({
      createBundlerClient: () => ({
        sendUserOperation: async () => {
          throw new Error("AA33 reverted");
        },
        waitForUserOperationReceipt: async () => ({ success: true, receipt: { transactionHash: "0x" } }),
      }),
    });
    const wallet = await openPasskeyWallet({ config: CONFIG, sdk });
    await expect(wallet.send(TO, 1_500_000n)).rejects.toThrow("AA33 reverted");
  });

  it("sends to an address written in capitals alone, as the forms take it (review finding 5)", () => {
    const call = transferCall(TO.toUpperCase().replace("0X", "0x"), 1n);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args?.[0]).toBe(TO);
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
    expect(sendProblem({ to: TO, amount: "1.5", balance: 2_000_000n, from: SMART })).toBeNull();
    expect(sendProblem({ to: "0x123", amount: "1.5", balance: 2_000_000n, from: SMART })).toBe(
      "That doesn't look like a wallet address. It starts with 0x and has 42 characters in all."
    );
    expect(sendProblem({ to: "0x840DE234Bfc3F66fA380888A0a8204D9487D60d4", amount: "1.5", balance: 2_000_000n, from: SMART })).toMatch(/checksum/);
    expect(sendProblem({ to: TO, amount: "0", balance: 2_000_000n, from: SMART })).toBe("Enter an amount of USDC, such as 1.50.");
    expect(sendProblem({ to: TO, amount: "3", balance: 2_000_000n, from: SMART })).toBe("This wallet holds 2.00 USDC.");
    expect(sendProblem({ to: SMART, amount: "1", balance: 2_000_000n, from: SMART })).toBe("That is this wallet's own address.");
  });

  it("says a balance it could not read, rather than reading it as none (review finding 4)", () => {
    expect(sendProblem({ to: TO, amount: "1", balance: null, from: SMART })).toBe("This wallet's USDC could not be read. Choose Refresh, then try again.");
  });
});

describe("what a person is told when it fails (P5)", () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("says a cancelled or timed-out passkey changed nothing", () => {
    expect(passkeyFailure(named("NotAllowedError"), "create")).toBe("No passkey was created. Nothing changed.");
    expect(passkeyFailure(named("NotAllowedError"), "open")).toBe("The passkey was not used. Nothing changed.");
    expect(passkeyFailure(named("NotAllowedError"), "send")).toBe("The passkey was not used. Nothing was sent.");
  });

  it("finds a cancelled passkey however deep the signing library wrapped it (review finding 3)", () => {
    const wrapped = Object.assign(new Error("Failed to sign."), { name: "Authentication.SignFailedError", cause: named("NotAllowedError") });
    expect(passkeyFailure(Object.assign(new Error("outer"), { cause: wrapped }), "send")).toBe("The passkey was not used. Nothing was sent.");
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
