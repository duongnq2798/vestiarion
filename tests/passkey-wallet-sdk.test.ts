import { decodeFunctionData, erc20Abi, isAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ARC_TESTNET } from "@/lib/network";
import { passkeyMark, passkeyName, passkeyWalletAddress, type PasskeySdk } from "@/lib/passkey-wallet";
import { circleUserOperationFees, passkeySdk } from "@/lib/passkey-wallet-sdk";
import { openPasskeyWallet } from "@/lib/passkey-wallet-send";

/**
 * The real binding (src/lib/passkey-wallet-sdk.ts): Circle's Modular Wallets SDK and the app's viem, run together as the
 * browser runs them, with only the browser's passkey API and the network faked (payee passkey wallet review). A swapped
 * mode, a wrong bundler key or a lost rpId fails here, where the module's own tests inject the SDK whole. The faked
 * Circle answers a passkey's registration as the live one did on 2026-10-05: a username outside its rule is refused
 * (-32025), and so is one it has been asked for before (-32024).
 */

const HOST = "www.vestiarion.xyz";
const CREDENTIAL_ID = "Y3JlZGVudGlhbC1pZC0x";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const assertions: Array<{ rpId: string }> = [];
const created: Array<{ rpId: string; name: string }> = [];
const usernames = new Set<string>();
let createdKey: ArrayBuffer | null = null;
const rpc: Array<{ url: string; method: string; params: unknown[] }> = [];
let circleAddress = "0x0000000000000000000000000000000000000000";
let receipt: "success" | "reverted" | "unreachable" = "success";
let sentOperation: Record<string, unknown> | null = null;

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const saved = { window: (globalThis as { window?: unknown }).window, fetch: globalThis.fetch };

beforeAll(() => {
  (globalThis as { window?: unknown }).window = {
    location: { hostname: HOST, protocol: "https:" },
    navigator: {
      credentials: {
        async create(options: { publicKey: { rp: { id: string }; user: { name: string } } }) {
          created.push({ rpId: options.publicKey.rp.id, name: options.publicKey.user.name });
          const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
          createdKey = await crypto.subtle.exportKey("spki", pair.publicKey);
          const spki = createdKey;
          return { id: CREDENTIAL_ID, rawId: new Uint8Array(16).buffer, type: "public-key", response: { getPublicKey: () => spki } };
        },
        async get(options: { publicKey: { rpId: string; challenge: Uint8Array } }) {
          assertions.push({ rpId: options.publicKey.rpId });
          const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: base64url(options.publicKey.challenge), origin: `https://${HOST}` });
          const authenticatorData = new Uint8Array(37);
          authenticatorData[32] = 0x05;
          const der = Uint8Array.from([0x30, 0x44, 0x02, 0x20, ...new Uint8Array(32).fill(1), 0x02, 0x20, ...new Uint8Array(32).fill(2)]);
          return {
            id: CREDENTIAL_ID,
            type: "public-key",
            response: { clientDataJSON: new TextEncoder().encode(clientDataJSON).buffer, authenticatorData: authenticatorData.buffer, signature: der.buffer, userHandle: null },
          };
        },
      },
    },
  };
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    rpc.push({ url, method: body.method, params: body.params });
    const params = body.params as Array<Record<string, unknown>>;
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    const refuse = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code, message } }), { status: 200 });
    switch (body.method) {
      case "rp_getRegistrationOptions": {
        const username = String(body.params[0]);
        if (!/^[A-Za-z0-9_@.:+-]{5,50}$/.test(username)) {
          return refuse(-32025, "The username is invalid. It should be 5 to 50 characters and contain only alphanumeric and _@.:+- characters.");
        }
        if (usernames.has(username)) return refuse(-32024, "The username is duplicated.");
        usernames.add(username);
        return reply({
          rp: { name: HOST, id: HOST },
          user: { name: username, displayName: username, id: base64url(new Uint8Array(16).fill(7)) },
          challenge: base64url(new Uint8Array(32).fill(9)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 300000,
          authenticatorSelection: { requireResidentKey: true, residentKey: "required", userVerification: "required" },
        });
      }
      case "rp_getRegistrationVerification":
        return reply({ verified: true });
      case "circle_getAddress":
        return reply({ id: "w1", address: circleAddress, blockchain: "ARC-TESTNET", state: "LIVE", name: (params[0].metadata as { name: string }).name, scaConfiguration: params[0].scaConfiguration });
      case "eth_chainId":
        return reply(`0x${ARC_TESTNET.chainId.toString(16)}`);
      case "eth_call": {
        const data = String(params[0].data ?? params[0].input);
        return reply(data.startsWith("0x70a08231") ? word(12_340_000n) : word(0n));
      }
      case "eth_getCode":
        return reply("0x");
      case "eth_getBlockByNumber":
        return reply({
          number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0",
          baseFeePerGas: "0x2540be400", transactions: [], uncles: [], miner: `0x${"00".repeat(20)}`, extraData: "0x", logsBloom: `0x${"00".repeat(256)}`,
          difficulty: "0x0", nonce: "0x0000000000000000", sha3Uncles: `0x${"33".repeat(32)}`, size: "0x1", stateRoot: `0x${"44".repeat(32)}`,
          receiptsRoot: `0x${"55".repeat(32)}`, transactionsRoot: `0x${"66".repeat(32)}`, mixHash: `0x${"77".repeat(32)}`,
        });
      case "eth_maxPriorityFeePerGas":
        return reply("0x3b9aca00");
      case "circle_getUserOperationGasPrice":
        // Tiers as Circle's Arc mainnet bundler gave them on 2026-10-07, in decimal: well above the chain's own priority fee.
        return reply({
          low: { maxPriorityFeePerGas: "3000005739", maxFeePerGas: "43000005739" },
          medium: { maxPriorityFeePerGas: "4223405131", maxFeePerGas: "44223405131" },
          high: { maxPriorityFeePerGas: "5723405526", maxFeePerGas: "45723405526" },
          deployed: "100000",
          notDeployed: "600000",
        });
      case "pm_getPaymasterStubData":
        return reply({ paymaster: `0x${"99".repeat(20)}`, paymasterData: "0x", paymasterVerificationGasLimit: "0x10000", paymasterPostOpGasLimit: "0x10000", isFinal: false });
      case "eth_estimateUserOperationGas":
        return reply({ preVerificationGas: "0x10000", verificationGasLimit: "0x10000", callGasLimit: "0x10000", paymasterVerificationGasLimit: "0x10000", paymasterPostOpGasLimit: "0x10000" });
      case "pm_getPaymasterData":
        return reply({ paymaster: `0x${"99".repeat(20)}`, paymasterData: "0x1234" });
      case "eth_sendUserOperation":
        sentOperation = params[0];
        return reply(`0x${"ab".repeat(32)}`);
      case "eth_getUserOperationReceipt":
        if (receipt === "unreachable") throw new TypeError("fetch failed");
        return reply({
          userOpHash: params[0], entryPoint: ENTRY_POINT, sender: circleAddress, nonce: "0x0", paymaster: `0x${"99".repeat(20)}`,
          actualGasCost: "0x1", actualGasUsed: "0x1", success: receipt === "success", reason: receipt === "success" ? "" : "0x08c379a0", logs: [],
          receipt: {
            transactionHash: `0x${"cd".repeat(32)}`, blockHash: `0x${"11".repeat(32)}`, blockNumber: "0x10", from: `0x${"88".repeat(20)}`, to: ENTRY_POINT,
            gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1",
            transactionIndex: "0x0", type: "0x2", contractAddress: null,
          },
        });
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `unexpected ${body.method}` } }), { status: 200 });
    }
  }) as typeof fetch;
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  globalThis.fetch = saved.fetch;
});

beforeEach(() => {
  assertions.length = 0;
  created.length = 0;
  createdKey = null;
  rpc.length = 0;
  receipt = "success";
  sentOperation = null;
});

/** A real P-256 public key, in the shape the SDK's toWebAuthnCredential returns (x||y, hex). */
async function publicKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return `0x${Buffer.from(raw.slice(1)).toString("hex")}`;
}

/** The real binding, with only the passkey ceremony replaced: it returns a credential bound to `rpId`. */
function binding(key: string, rpId: string, modes: string[] = []): PasskeySdk {
  const real = passkeySdk();
  return { ...real, toWebAuthnCredential: async (parameters) => (modes.push(parameters.mode), { id: CREDENTIAL_ID, publicKey: key, raw: {}, rpId }) };
}

const LOCAL = { clientKey: "TEST_CLIENT_KEY:x", clientUrl: "https://rpc.example.test/v1" };
const CIRCLE = { clientKey: "TEST_CLIENT_KEY:x", clientUrl: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl" };

describe("the Modular Wallets binding, with the app's viem", () => {
  it("registers the passkey with Circle under the name a payee link gives it, whatever the business is called", async () => {
    circleAddress = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
    const name = passkeyName("testnet-2 (Công ty Đất Việt)", passkeyMark());
    const made = await passkeyWalletAddress({ config: CIRCLE, mode: "Register", username: name, sdk: passkeySdk() });
    expect(rpc.filter((call) => call.method === "rp_getRegistrationOptions").map((call) => call.params)).toEqual([[name]]);
    expect(created).toEqual([{ rpId: HOST, name }]);
    expect(createdKey).not.toBeNull();
    expect(made.address).toBe(circleAddress);
  }, 30_000);

  it("gives the same wallet for a passkey registered from a payee link and the same passkey logging in at /wallet", async () => {
    const key = await publicKey();
    const modes: string[] = [];
    const made = await passkeyWalletAddress({ config: LOCAL, mode: "Register", username: "Northstar (Vestiarion 4f2a)", sdk: binding(key, HOST, modes) });
    const opened = await passkeyWalletAddress({ config: LOCAL, mode: "Login", sdk: binding(key, HOST, modes) });
    expect(modes).toEqual(["Register", "Login"]);
    expect(opened.address).toBe(made.address);
    expect(isAddress(made.address, { strict: true })).toBe(true);
  }, 30_000);

  it("asks Circle for the wallet on Arc testnet's path, through the app's public client", async () => {
    const key = await publicKey();
    circleAddress = (await passkeyWalletAddress({ config: LOCAL, mode: "Register", sdk: binding(key, HOST) })).address;
    rpc.length = 0;
    const made = await passkeyWalletAddress({ config: CIRCLE, mode: "Register", sdk: binding(key, HOST) });
    const asked = rpc.filter((call) => call.method === "circle_getAddress");
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe(`${CIRCLE.clientUrl}/arcTestnet`);
    expect(made.address).toBe(circleAddress);
  }, 30_000);

  it("signs a send with the passkey's own rpId and sends the USDC transfer with Gas Station as paymaster (review finding 2)", async () => {
    const key = await publicKey();
    circleAddress = (await passkeyWalletAddress({ config: LOCAL, mode: "Register", sdk: binding(key, "vestiarion.xyz") })).address;
    const wallet = await openPasskeyWallet({ config: CIRCLE, sdk: binding(key, "vestiarion.xyz") });
    expect(await wallet.balance()).toBe(12_340_000n);

    const to = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
    expect(await wallet.send(to, 1_500_000n)).toEqual({ kind: "sent", txHash: `0x${"cd".repeat(32)}` });

    expect(assertions.map((assertion) => assertion.rpId)).toEqual(["vestiarion.xyz"]);
    const operation = sentOperation as { callData: `0x${string}`; paymaster: string; sender: string; maxFeePerGas: string; maxPriorityFeePerGas: string };
    expect(operation.sender.toLowerCase()).toBe(circleAddress.toLowerCase());
    // Priced by Circle's own user operation gas price, not the chain's priority fee (1 gwei here), which Circle's Arc
    // mainnet bundler refused on 2026-10-07: the first passkey setup failed there.
    expect(BigInt(operation.maxFeePerGas)).toBe(44_223_405_131n);
    expect(BigInt(operation.maxPriorityFeePerGas)).toBe(4_223_405_131n);
    expect(operation.paymaster).toBe(`0x${"99".repeat(20)}`);
    // execute(USDC, 0, transfer(to, 1.5 USDC)) on the smart account: the transfer's calldata is inside it.
    const transfer = `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${(1_500_000n).toString(16).padStart(64, "0")}`;
    expect(operation.callData.toLowerCase()).toContain(transfer.slice(2));
    expect(operation.callData.toLowerCase()).toContain(ARC_TESTNET.tokens.USDC.slice(2).toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: transfer as `0x${string}` }).args).toEqual([to, 1_500_000n]);
  }, 30_000);

  it("reports a reverted transfer, and one whose receipt could not be read, as what they are (review finding 1)", async () => {
    const key = await publicKey();
    circleAddress = (await passkeyWalletAddress({ config: LOCAL, mode: "Register", sdk: binding(key, HOST) })).address;
    const wallet = await openPasskeyWallet({ config: CIRCLE, sdk: binding(key, HOST) });

    receipt = "reverted";
    expect(await wallet.send("0x840de234Bfc3F66fA380888A0a8204D9487D60d4", 1n)).toEqual({ kind: "reverted", txHash: `0x${"cd".repeat(32)}` });

    receipt = "unreachable";
    expect(await wallet.send("0x840de234Bfc3F66fA380888A0a8204D9487D60d4", 1n)).toEqual({ kind: "unconfirmed", userOpHash: `0x${"ab".repeat(32)}` });
  }, 60_000);
});

describe("circleUserOperationFees", () => {
  const bundler = (answer: unknown) => ({ request: async () => answer });

  it("takes Circle's medium tier, given in decimal or in hex", async () => {
    expect(await circleUserOperationFees(bundler({ medium: { maxFeePerGas: "44223405131", maxPriorityFeePerGas: "4223405131" } }))).toEqual({
      maxFeePerGas: 44_223_405_131n,
      maxPriorityFeePerGas: 4_223_405_131n,
    });
    expect(await circleUserOperationFees(bundler({ medium: { maxFeePerGas: "0xa4c49b04b", maxPriorityFeePerGas: "0xfbbd3b4b" } }))).toEqual({
      maxFeePerGas: 0xa4c49b04bn,
      maxPriorityFeePerGas: 0xfbbd3b4bn,
    });
  });

  it("falls back to another tier, and never offers less than 1 gwei for priority", async () => {
    expect(await circleUserOperationFees(bundler({ high: { maxFeePerGas: "45000000000", maxPriorityFeePerGas: "500" } }))).toEqual({
      maxFeePerGas: 45_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
  });

  it("refuses to price an operation Circle gave no price for", async () => {
    await expect(circleUserOperationFees(bundler({ low: {}, medium: {}, high: {} }))).rejects.toThrow("Circle gave no gas price for this operation.");
  });
});

describe("the binding for a passkey treasury (passkey treasury K2, K8)", () => {
  it("binds Arc mainnet, not a testnet, and carries Circle's recovery", async () => {
    const { ARC_MAINNET } = await import("@/lib/network");
    const sdk = passkeySdk(ARC_MAINNET);
    expect(sdk.chain).toMatchObject({ id: 5042, name: "Arc mainnet", testnet: false, nativeCurrency: { symbol: "USDC", decimals: 18 } });
    expect(typeof sdk.registerRecoveryAddress).toBe("function");
    expect(passkeySdk().chain).toMatchObject({ id: ARC_TESTNET.chainId, testnet: true });
  });
});
