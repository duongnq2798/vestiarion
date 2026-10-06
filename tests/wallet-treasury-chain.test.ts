import { describe, expect, it } from "vitest";
import { encodeAbiParameters, erc20Abi, decodeFunctionData, type Hex } from "viem";
import { treasuryChain } from "@/lib/treasury/chain";
import { ARC_MAINNET } from "@/lib/network";

/**
 * What the server reads of an owner's wallet and their contract on Arc (docs/superpowers/specs/2026-10-07-wallet-
 * treasury-design.md W7–W9, W12), over the network's RPC: receipts, code, a deployment simulated, contract reads, and
 * balances. Each read is one JSON-RPC call, checked here against a fake endpoint.
 */

const WALLET = "0x5aF3107A4000000000000000000000000000b0b0" as Hex;
const CONTRACT = "0x5aF3107A4000000000000000000000000000e5c0" as Hex;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const UNMINED = `0x${"cd".repeat(32)}` as Hex;
const RUNTIME = "0x6080604052" as Hex;

type Call = { method: string; params: unknown[] };

function fakeRpc(answer: (call: Call) => { result?: unknown; error?: { code: number; message: string; data?: string } }) {
  const calls: Array<{ url: string; call: Call }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call & { id: number; jsonrpc: string };
    calls.push({ url: String(url), call: { method: body.method, params: body.params } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer(body) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const receipt = (fields: Record<string, unknown>) => ({
  transactionHash: HASH,
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: "0x10",
  transactionIndex: "0x0",
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x1",
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  type: "0x2",
  ...fields,
});

describe("treasuryChain", () => {
  it("reads a mined receipt, and says nothing of one not mined yet", async () => {
    const { fetchFn, calls } = fakeRpc(({ method, params }) => {
      if (method !== "eth_getTransactionReceipt") return { error: { code: -32601, message: "unexpected" } };
      return { result: params[0] === UNMINED ? null : receipt({ status: "0x1", from: WALLET.toLowerCase(), to: null, contractAddress: CONTRACT.toLowerCase() }) };
    });
    const chain = treasuryChain(ARC_MAINNET, { rpcUrl: "https://rpc.example", fetch: fetchFn });
    expect(await chain.receipt(HASH)).toEqual({ status: "success", from: WALLET.toLowerCase(), to: null, contractAddress: CONTRACT.toLowerCase() });
    expect(await chain.receipt(UNMINED)).toBeNull();
    expect(calls.every((entry) => new URL(entry.url).host === "rpc.example")).toBe(true);
  });

  it("reads code, and none as 0x", async () => {
    const { fetchFn } = fakeRpc(({ method, params }) => (method === "eth_getCode" ? { result: String(params[0]).toLowerCase() === CONTRACT.toLowerCase() ? RUNTIME : "0x" } : {}));
    const chain = treasuryChain(ARC_MAINNET, { rpcUrl: "https://rpc.example", fetch: fetchFn });
    expect(await chain.code(CONTRACT)).toBe(RUNTIME);
    expect(await chain.code(WALLET)).toBe("0x");
  });

  it("simulates a deployment with an eth_call that has no `to`, and returns the runtime code", async () => {
    const { fetchFn, calls } = fakeRpc(({ method }) => (method === "eth_call" ? { result: RUNTIME } : {}));
    const chain = treasuryChain(ARC_MAINNET, { rpcUrl: "https://rpc.example", fetch: fetchFn });
    expect(await chain.simulateDeploy({ from: WALLET, data: "0x6080" })).toBe(RUNTIME);
    const [sent] = calls.map((entry) => entry.call.params[0] as Record<string, unknown>);
    expect(String(sent.from).toLowerCase()).toBe(WALLET.toLowerCase());
    expect(sent.data).toBe("0x6080");
    expect(sent).not.toHaveProperty("to");
  });

  it("reads the USDC balance and allowance of the profile's USDC, and the native balance", async () => {
    const { fetchFn, calls } = fakeRpc(({ method, params }) => {
      if (method === "eth_getBalance") return { result: "0x6f05b59d3b20000" }; // 0.5 USDC in 18 decimals
      if (method !== "eth_call") return {};
      const { functionName } = decodeFunctionData({ abi: erc20Abi, data: (params[0] as { data: Hex }).data });
      return { result: encodeAbiParameters([{ type: "uint256" }], [functionName === "balanceOf" ? 12_500_000n : 3_000_000n]) };
    });
    const chain = treasuryChain(ARC_MAINNET, { rpcUrl: "https://rpc.example", fetch: fetchFn });
    expect(await chain.usdcBalance(WALLET)).toBe(12_500_000n);
    expect(await chain.allowance(WALLET, CONTRACT)).toBe(3_000_000n);
    expect(await chain.nativeBalance(WALLET)).toBe(500_000_000_000_000_000n);
    const tokens = calls.filter((entry) => entry.call.method === "eth_call").map((entry) => (entry.call.params[0] as { to: string }).to.toLowerCase());
    expect(tokens).toEqual([ARC_MAINNET.tokens.USDC.toLowerCase(), ARC_MAINNET.tokens.USDC.toLowerCase()]);
  });

  it("throws on a read the contract reverts", async () => {
    const { fetchFn } = fakeRpc(() => ({ error: { code: 3, message: "execution reverted", data: "0x08c379a0" } }));
    const chain = treasuryChain(ARC_MAINNET, { rpcUrl: "https://rpc.example", fetch: fetchFn });
    await expect(chain.read(CONTRACT, "0x12345678")).rejects.toThrow();
  });
});

describe("a node that fails", () => {
  it("is asked once and read as unreadable at once, never retried while a page waits", async () => {
    // viem retries a failed call three times by default: with Settings reading in three stages, a failing node held the
    // page for minutes. Callers already treat a failed read as unreadable, and the setup's page asks again itself.
    const calls: string[] = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as Call).method);
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const chain = treasuryChain(ARC_MAINNET, { rpcUrl: "https://rpc.test.invalid", fetch: fetchFn });
    await expect(chain.usdcBalance(WALLET)).rejects.toThrow();
    expect(calls).toEqual(["eth_call"]);
  });
});
