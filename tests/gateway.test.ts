import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_MINTER,
  GATEWAY_WALLET,
  GatewayError,
  burnIntent,
  burnIntentTypedData,
  estimateGateway,
  gatewayBalance,
  gatewaySalt,
  gatewayTransferStatus,
  submitGatewayTransfer,
} from "@/lib/circle/gateway";

/**
 * Circle Gateway from Arc testnet (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md G3):
 * the burn intent and its EIP-712 typed data exactly as Circle's reference builds them, and the
 * testnet API's estimate, balance, transfer and status, as they answered on 2026-10-01.
 */

const DEPOSITOR = "0x97F85033bBD83870a841cF7153F35b387746B6b6";
const SIGNER = "0x5aF3107A4000000000000000000000000000b0b0";
const PAYEE = "0x19801dAA0000000000000000000000000000Fdd1";
const b32 = (address: string) => `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the salt of a Gateway transfer", () => {
  it("is the same for every attempt under the same key, and differs between keys", () => {
    expect(gatewaySalt("key-a")).toBe(gatewaySalt("key-a"));
    expect(gatewaySalt("key-a")).not.toBe(gatewaySalt("key-b"));
    expect(gatewaySalt("key-a")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("the burn intent", () => {
  const intent = burnIntent({ depositor: DEPOSITOR, signer: SIGNER, recipient: PAYEE, chain: "BASE-SEPOLIA", amount: 1.25, salt: gatewaySalt("k"), maxFee: BigInt(56724), maxBlockHeight: "66288611" });

  it("burns on Arc testnet from the depositor and mints to the payee on its chain", () => {
    expect(intent).toEqual({
      maxBlockHeight: "66288611",
      maxFee: "56724",
      spec: {
        version: 1,
        sourceDomain: 26,
        destinationDomain: 6,
        sourceContract: b32(GATEWAY_WALLET),
        destinationContract: b32(GATEWAY_MINTER),
        sourceToken: b32("0x3600000000000000000000000000000000000000"),
        destinationToken: b32("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
        sourceDepositor: b32(DEPOSITOR),
        destinationRecipient: b32(PAYEE),
        sourceSigner: b32(SIGNER),
        destinationCaller: b32("0x0000000000000000000000000000000000000000"),
        value: "1250000",
        salt: gatewaySalt("k"),
        hookData: "0x",
      },
    });
  });

  it("is signed as Circle's BurnIntent typed data, in the GatewayWallet domain", () => {
    const typed = burnIntentTypedData(intent);
    expect(typed.domain).toEqual({ name: "GatewayWallet", version: "1" });
    expect(typed.primaryType).toBe("BurnIntent");
    expect(typed.types.BurnIntent).toEqual([
      { name: "maxBlockHeight", type: "uint256" },
      { name: "maxFee", type: "uint256" },
      { name: "spec", type: "TransferSpec" },
    ]);
    expect(typed.types.TransferSpec.map((field) => `${field.name}:${field.type}`)).toEqual([
      "version:uint32", "sourceDomain:uint32", "destinationDomain:uint32", "sourceContract:bytes32", "destinationContract:bytes32",
      "sourceToken:bytes32", "destinationToken:bytes32", "sourceDepositor:bytes32", "destinationRecipient:bytes32", "sourceSigner:bytes32",
      "destinationCaller:bytes32", "value:uint256", "salt:bytes32", "hookData:bytes",
    ]);
    expect(typed.types.EIP712Domain).toEqual([{ name: "name", type: "string" }, { name: "version", type: "string" }]);
    expect(typed.message).toBe(intent);
  });

  it("refuses a payee chain Gateway cannot mint on from here", () => {
    expect(() => burnIntent({ depositor: DEPOSITOR, signer: SIGNER, recipient: PAYEE, chain: "ARC-TESTNET", amount: 1, salt: gatewaySalt("k"), maxFee: BigInt(1), maxBlockHeight: "1" })).toThrow(GatewayError);
  });
});

describe("the Gateway API", () => {
  it("estimates a forwarded transfer: the fee to put in the burn intent, and its block height", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      respond(200, { body: [{ burnIntent: { maxBlockHeight: "66288611", maxFee: "56724" } }], fees: { token: "USDC", total: "0.056724", forwardingFee: "0.053224" } })
    );
    const estimate = await estimateGateway({ depositor: DEPOSITOR, signer: SIGNER, recipient: PAYEE, chain: "BASE-SEPOLIA", amount: 1, salt: gatewaySalt("k") }, { fetch });
    expect(estimate).toEqual({ maxFee: BigInt(56724), maxBlockHeight: "66288611", feeUsdc: 0.056724 });
    expect(String(fetch.mock.calls[0][0])).toBe("https://gateway-api-testnet.circle.com/v1/estimate?enableForwarder=true");
    const sent = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body)) as Array<{ spec: { destinationDomain: number; value: string } }>;
    expect(sent[0].spec).toMatchObject({ destinationDomain: 6, value: "1000000" });
  });

  it("reads the depositor's Gateway balance, summed over the domains it answers for", async () => {
    const fetch = vi.fn(async () => respond(200, { token: "USDC", balances: [{ domain: 26, depositor: DEPOSITOR, balance: "2.5" }, { domain: 6, depositor: DEPOSITOR, balance: "0.25" }] }));
    expect(await gatewayBalance(DEPOSITOR, { fetch })).toBe(2.75);
  });

  it("submits a signed burn intent with forwarding, and returns the transfer id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => respond(201, { transferId: "tr-1" }));
    const intent = burnIntent({ depositor: DEPOSITOR, signer: SIGNER, recipient: PAYEE, chain: "BASE-SEPOLIA", amount: 1, salt: gatewaySalt("k"), maxFee: BigInt(56724), maxBlockHeight: "66288611" });
    expect(await submitGatewayTransfer(intent, "0xsig", { fetch })).toBe("tr-1");
    expect(String(fetch.mock.calls[0][0])).toBe("https://gateway-api-testnet.circle.com/v1/transfer?enableForwarder=true");
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual([{ burnIntent: intent, signature: "0xsig" }]);
  });

  it("reads a transfer's status: the mint on the payee's chain once confirmed or finalized; failed when it failed or expired", async () => {
    const read = (body: unknown) => gatewayTransferStatus("tr-1", { fetch: (async () => respond(200, body)) as unknown as typeof globalThis.fetch });
    expect(await read({ status: "pending", destinationDomain: 6 })).toEqual({ status: "pending", state: "pending", mintTxHash: null, failureReason: null, destinationChain: "BASE-SEPOLIA" });
    expect(await read({ status: "confirmed", destinationDomain: 3, transactionHash: "0xmint" })).toEqual({ status: "confirmed", state: "confirmed", mintTxHash: "0xmint", failureReason: null, destinationChain: "ARB-SEPOLIA" });
    expect(await read({ status: "finalized", transactionHash: "0xmint" })).toMatchObject({ status: "confirmed", state: "finalized", mintTxHash: "0xmint", destinationChain: null });
    // Gateway's own word is kept: a failed transfer may still be minted, an expired one never can (review I2).
    expect(await read({ status: "failed", destinationDomain: 6, forwardingDetails: { forwardingEnabled: true, failureReason: "out of gas" } })).toEqual({ status: "failed", state: "failed", mintTxHash: null, failureReason: "out of gas", destinationChain: "BASE-SEPOLIA" });
    expect(await read({ status: "failed", destinationDomain: 6 })).toMatchObject({ failureReason: "Gateway reported the transfer failed" });
    expect(await read({ status: "expired", destinationDomain: 0 })).toEqual({ status: "failed", state: "expired", mintTxHash: null, failureReason: "Gateway's attestation expired before the mint", destinationChain: "ETH-SEPOLIA" });
  });

  it("says a transfer Gateway never answered, answered 5xx, or took with no id may or may not have been accepted (payment safety R1)", async () => {
    const intent = burnIntent({ depositor: DEPOSITOR, signer: SIGNER, recipient: PAYEE, chain: "BASE-SEPOLIA", amount: 1, salt: gatewaySalt("k"), maxFee: BigInt(1), maxBlockHeight: "1" });
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    const failing = (async () => respond(503, { message: "Service Unavailable" })) as unknown as typeof globalThis.fetch;
    const noId = (async () => respond(200, {})) as unknown as typeof globalThis.fetch;

    await expect(submitGatewayTransfer(intent, "0xsig", { fetch: down })).rejects.toThrow(
      new GatewayError("Gateway did not answer the transfer; it may or may not have been accepted")
    );
    await expect(submitGatewayTransfer(intent, "0xsig", { fetch: failing })).rejects.toThrow(
      new GatewayError("Gateway answered 503 to the transfer: Service Unavailable; it may or may not have been accepted")
    );
    await expect(submitGatewayTransfer(intent, "0xsig", { fetch: noId })).rejects.toThrow(
      new GatewayError("Gateway answered the transfer with no transfer id; it may or may not have been accepted")
    );
  });

  it("turns an HTTP error or no answer into a GatewayError, with Gateway's own message", async () => {
    const refused = (async () => respond(400, { message: "Insufficient balance for depositor" })) as unknown as typeof globalThis.fetch;
    await expect(submitGatewayTransfer(burnIntent({ depositor: DEPOSITOR, signer: SIGNER, recipient: PAYEE, chain: "BASE-SEPOLIA", amount: 1, salt: gatewaySalt("k"), maxFee: BigInt(1), maxBlockHeight: "1" }), "0xsig", { fetch: refused })).rejects.toThrow(
      new GatewayError("Gateway answered 400 to the transfer: Insufficient balance for depositor", 400)
    );
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    await expect(gatewayBalance(DEPOSITOR, { fetch: down })).rejects.toThrow(new GatewayError("Gateway did not answer the balance read"));
  });
});
