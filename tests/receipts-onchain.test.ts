import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetMinedReceipts, matchTransfer, readOnChain, receiptRpcUrl, type TxReceipt } from "@/lib/receipts/onchain";
import type { ReceiptFacts } from "@/lib/receipts/facts";

/**
 * A receipt's on-chain check (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P5 check 3):
 * the transaction's receipt, read from the chain, must hold a transfer of the amount to the payee in the
 * token. On Arc testnet native USDC is logged by the system address at 18 decimals (observed on real
 * payments), and gas is a second transfer, to the bundler, that must not count.
 */

const PAYEE = "0x67C8000000000000000000000000000000000504A".slice(0, 42);
const WALLET = "0x97F85033bBD83870a841cF7153F35b387746B6b6";
const BUNDLER = "0xdea3000000000000000000000000000000000bfbc".slice(0, 42);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const log = (address: string, from: string, to: string, value: bigint) => ({ address, topics: [TRANSFER, topic(from), topic(to)], data: word(value) });
const TX = `0x${"1".repeat(64)}`;

const facts = (overrides: Partial<ReceiptFacts> = {}): ReceiptFacts => ({
  amount: 2, token: "USDC", paidAt: "2026-10-01T08:50:42Z", payee: PAYEE, chain: "ARC-TESTNET", txHash: TX, route: "direct", ...overrides,
});
const receipt = (logs: TxReceipt["logs"], status = "0x1"): TxReceipt => ({ status, blockNumber: "0x1f4", logs });

describe("matchTransfer", () => {
  it("finds Arc testnet's native USDC transfer at 18 decimals, beside the gas paid to the bundler", () => {
    const logs = [
      log("0xfffffffffffffffffffffffffffffffffffffffe", WALLET, PAYEE, BigInt("2000000000000000000")),
      log("0xfffffffffffffffffffffffffffffffffffffffe", "0x0000000071727de22e5e9d8baf0edac6f37da032", BUNDLER, BigInt("7179354338750000")),
    ];
    expect(matchTransfer(facts(), receipt(logs))).toEqual({ state: "matches", block: 500 });
  });

  it("finds USDC's ERC-20 transfer at 6 decimals", () => {
    expect(matchTransfer(facts(), receipt([log("0x3600000000000000000000000000000000000000", WALLET, PAYEE, BigInt(2_000_000))]))).toEqual({ state: "matches", block: 500 });
  });

  it("finds a EURC transfer from EURC's contract", () => {
    const eurc = facts({ token: "EURC", amount: 1.9 });
    expect(matchTransfer(eurc, receipt([log("0x89b50855aa3be2f677cd6303cec089b5f319d72a", WALLET, PAYEE, BigInt(1_900_000))]))).toEqual({ state: "matches", block: 500 });
    // USDC moved instead of EURC is not this payment.
    expect(matchTransfer(eurc, receipt([log("0x3600000000000000000000000000000000000000", WALLET, PAYEE, BigInt(1_900_000))]))).toMatchObject({ state: "mismatch" });
  });

  it("finds a mint on the payee's chain, from the zero address", () => {
    const minted = facts({ chain: "ARB-SEPOLIA", route: "gateway" });
    const logs = [log("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", "0x0000000000000000000000000000000000000000", PAYEE, BigInt(2_000_000))];
    expect(matchTransfer(minted, receipt(logs))).toEqual({ state: "matches", block: 500 });
  });

  it("does not take the gas transfer, another amount, another payee or another chain's token for the payment", () => {
    expect(matchTransfer(facts(), receipt([log("0xfffffffffffffffffffffffffffffffffffffffe", "0x0000000071727de22e5e9d8baf0edac6f37da032", BUNDLER, BigInt("7179354338750000"))]))).toEqual({
      state: "mismatch",
      reason: `No transfer of 2 USDC to ${PAYEE} is in this transaction.`,
    });
    expect(matchTransfer(facts(), receipt([log("0x3600000000000000000000000000000000000000", WALLET, PAYEE, BigInt(1_999_999))]))).toMatchObject({ state: "mismatch" });
    expect(matchTransfer(facts(), receipt([log("0x3600000000000000000000000000000000000000", WALLET, BUNDLER, BigInt(2_000_000))]))).toMatchObject({ state: "mismatch" });
    expect(matchTransfer(facts({ chain: "BASE-SEPOLIA" }), receipt([log("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", WALLET, PAYEE, BigInt(2_000_000))]))).toMatchObject({ state: "mismatch" });
  });

  it("takes a CCTP mint that also carries the part of the fee Circle did not charge, never one above the fee (receipts review #3)", () => {
    const cctp = facts({ chain: "BASE-SEPOLIA", route: "cctp", feeUsdc: 0.054604 });
    const mint = (value: number) => receipt([log("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "0x0000000000000000000000000000000000000000", PAYEE, BigInt(value))]);
    expect(matchTransfer(cctp, mint(2_000_300))).toEqual({ state: "matches", block: 500 });
    expect(matchTransfer(cctp, mint(2_054_604))).toEqual({ state: "matches", block: 500 });
    expect(matchTransfer(cctp, mint(2_054_605))).toMatchObject({ state: "mismatch" });
    expect(matchTransfer(cctp, mint(1_999_999))).toMatchObject({ state: "mismatch" });
    // Gateway mints exactly the amount: its fee is taken from the balance, not the mint.
    expect(matchTransfer(facts({ chain: "BASE-SEPOLIA", route: "gateway", feeUsdc: 0.05 }), mint(2_000_300))).toMatchObject({ state: "mismatch" });
  });

  it("says a transaction that failed on chain is not the payment", () => {
    expect(matchTransfer(facts(), receipt([log("0x3600000000000000000000000000000000000000", WALLET, PAYEE, BigInt(2_000_000))], "0x0"))).toEqual({
      state: "mismatch",
      reason: "This transaction failed on chain.",
    });
  });
});

describe("readOnChain", () => {
  beforeEach(() => {
    forgetMinedReceipts();
  });

  const rpc = (answer: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(answer), { status }));

  it("reads the transaction's receipt from the chain's RPC and matches it", async () => {
    const fetch = rpc({ jsonrpc: "2.0", id: 1, result: receipt([log("0x3600000000000000000000000000000000000000", WALLET, PAYEE, BigInt(2_000_000))]) });
    expect(await readOnChain(facts(), { fetch: fetch as unknown as typeof globalThis.fetch, rpcUrl: () => "https://rpc.example" })).toEqual({ state: "matches", block: 500 });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ method: "eth_getTransactionReceipt", params: [TX] });
  });

  it("could not read a transaction the node does not know: a lagging or pruned node is not proof it is absent (receipts review #4)", async () => {
    const fetch = rpc({ jsonrpc: "2.0", id: 1, result: null });
    expect(await readOnChain(facts({ chain: "ARB-SEPOLIA", txHash: `0x${"4".repeat(64)}` }), { fetch: fetch as unknown as typeof globalThis.fetch, rpcUrl: () => "https://rpc.example" })).toEqual({
      state: "unreadable",
    });
  });

  it("reads a mined transaction once: its receipt never changes (receipts review #5)", async () => {
    const mined = { jsonrpc: "2.0", id: 1, result: receipt([log("0x3600000000000000000000000000000000000000", WALLET, PAYEE, BigInt(2_000_000))]) };
    const fetch = rpc(mined);
    const once = facts({ txHash: `0x${"5".repeat(64)}` });
    const options = { fetch: fetch as unknown as typeof globalThis.fetch, rpcUrl: () => "https://rpc.example" };
    expect(await readOnChain(once, options)).toEqual({ state: "matches", block: 500 });
    expect(await readOnChain(once, options)).toEqual({ state: "matches", block: 500 });
    // A different claim about the same transaction is matched afresh against the receipt read before.
    expect(await readOnChain({ ...once, amount: 3 }, options)).toMatchObject({ state: "mismatch" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again after a read that gave no receipt", async () => {
    const fetch = rpc({ jsonrpc: "2.0", id: 1, result: null });
    const missing = facts({ txHash: `0x${"6".repeat(64)}` });
    const options = { fetch: fetch as unknown as typeof globalThis.fetch, rpcUrl: () => "https://rpc.example" };
    await readOnChain(missing, options);
    await readOnChain(missing, options);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads Arc testnet through its public RPC, never the deployment's own (receipts review #5)", () => {
    expect(receiptRpcUrl("ARC-TESTNET")).toBe("https://rpc.testnet.arc.network");
    expect(receiptRpcUrl("BASE-SEPOLIA")).toBe("https://sepolia.base.org");
  });

  it("says it could not read the chain when the RPC errs, answers badly or does not answer", async () => {
    const options = (fetch: unknown) => ({ fetch: fetch as typeof globalThis.fetch, rpcUrl: () => "https://rpc.example" });
    expect(await readOnChain(facts(), options(rpc({ error: "busy" }, 503)))).toEqual({ state: "unreadable" });
    expect(await readOnChain(facts(), options(rpc({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } })))).toEqual({ state: "unreadable" });
    expect(await readOnChain(facts(), options(vi.fn(async () => { throw new Error("timed out"); })))).toEqual({ state: "unreadable" });
  });
});
