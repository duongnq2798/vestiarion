import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import artifact from "@/lib/spending-limit/artifact.json";
import { readSpendingLimit, spendingLimitRef, spendingLimitVerdict, usdcUnits } from "@/lib/spending-limit/onchain";

/**
 * Reading the spending limit contract without sending anything (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * R7, R8, R14): the contract's verdict on one payment, by an `eth_call` of `pay` from the agent's address, and its
 * figures and what it counts as paid. The node is a stand-in answering as an Ethereum JSON-RPC node does.
 */

const abi = artifact.abi as Abi;
const CONTRACT = "0x5aF3107A4000000000000000000000000000e5c0";
const AGENT = "0x5aF3107A4000000000000000000000000000a9e7";
const PAYEE = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
const REF = spendingLimitRef("invoice", "018f8ce0-1557-7b54-a931-4d777f6bcafe");

interface Sent {
  url: string;
  body: { method: string; params: Array<Record<string, string> | string> };
}

function node(answer: (body: Sent["body"]) => { status?: number; json: unknown }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent["body"];
    sent.push({ url, body });
    const reply = answer(body);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const reverted = (data: Hex) => ({ json: { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data } } });

describe("spendingLimitRef", () => {
  it("names a payment, not an attempt: the same source always gives the same 32 bytes, and another source others", () => {
    expect(REF).toMatch(/^0x[0-9a-f]{64}$/);
    expect(spendingLimitRef("invoice", "018f8ce0-1557-7b54-a931-4d777f6bcafe")).toBe(REF);
    expect(spendingLimitRef("milestone", "018f8ce0-1557-7b54-a931-4d777f6bcafe")).not.toBe(REF);
  });
});

describe("usdcUnits", () => {
  it("turns USDC into the token's 6-decimal units, without floating-point drift", () => {
    expect(usdcUnits(1.2)).toBe(1_200_000n);
    expect(usdcUnits(0.1 + 0.2)).toBe(300_000n);
    expect(usdcUnits(5)).toBe(5_000_000n);
  });
});

describe("spendingLimitVerdict", () => {
  it("asks the contract with an eth_call of the same pay, from the agent's address, and reads a quiet answer as allowed", async () => {
    const { fetch, sent } = node(() => ({ json: { jsonrpc: "2.0", id: 1, result: "0x" } }));
    const verdict = await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1.2, ref: REF }, { fetch, rpcUrl: "https://arc.example" });
    expect(verdict).toEqual({ state: "allowed" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://arc.example");
    expect(sent[0].body.method).toBe("eth_call");
    const [call, block] = sent[0].body.params as [Record<string, string>, string];
    expect(block).toBe("latest");
    expect(call.from.toLowerCase()).toBe(AGENT.toLowerCase());
    expect(call.to.toLowerCase()).toBe(CONTRACT.toLowerCase());
    const decoded = decodeFunctionData({ abi, data: call.data as Hex });
    expect(decoded.functionName).toBe("pay");
    expect(decoded.args).toEqual([PAYEE, 1_200_000n, REF]);
  });

  it("reads a refusal past the daily or 7-day figure with what was paid, the amount and the figure, in USDC", async () => {
    const daily = node(() => reverted(encodeErrorResult({ abi, errorName: "OverDailyLimit", args: [4_000_000n, 1_500_000n, 5_000_000n] })));
    expect(await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1.5, ref: REF }, { fetch: daily.fetch })).toEqual({
      state: "refused",
      error: "OverDailyLimit",
      spent: 4,
      amount: 1.5,
      limit: 5,
    });
    const weekly = node(() => reverted(encodeErrorResult({ abi, errorName: "OverWeeklyLimit", args: [20_000_000n, 1_000_000n, 20_000_000n] })));
    expect(await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1, ref: REF }, { fetch: weekly.fetch })).toEqual({
      state: "refused",
      error: "OverWeeklyLimit",
      spent: 20,
      amount: 1,
      limit: 20,
    });
  });

  it("reads a payment already made through the contract, and any other refusal by name", async () => {
    const again = node(() => reverted(encodeErrorResult({ abi, errorName: "AlreadyPaid", args: [REF] })));
    expect(await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1, ref: REF }, { fetch: again.fetch })).toEqual({
      state: "refused",
      error: "AlreadyPaid",
    });
    const stranger = node(() => reverted(encodeErrorResult({ abi, errorName: "NotAgent" })));
    expect(await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1, ref: REF }, { fetch: stranger.fetch })).toEqual({
      state: "refused",
      error: "NotAgent",
    });
  });

  it("says unreadable, never allowed, when the node does not answer or the revert cannot be named", async () => {
    const down = node(() => ({ status: 502, json: {} }));
    expect((await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1, ref: REF }, { fetch: down.fetch })).state).toBe("unreadable");
    const plain = node(() => ({ json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } } }));
    expect((await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1, ref: REF }, { fetch: plain.fetch })).state).toBe("unreadable");
    const strange = node(() => reverted("0xdeadbeef"));
    expect((await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1, ref: REF }, { fetch: strange.fetch })).state).toBe("unreadable");
    const thrown = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof globalThis.fetch;
    expect((await spendingLimitVerdict({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 1, ref: REF }, { fetch: thrown })).state).toBe("unreadable");
  });
});

describe("readSpendingLimit", () => {
  it("reads the contract's figures and what it counts as paid today and in 7 days, in USDC, 0 as not set", async () => {
    const values: Record<string, bigint> = { dailyLimit: 5_000_000n, weeklyLimit: 0n, spentToday: 1_200_000n, spentThisWeek: 3_700_000n };
    const { fetch } = node((body) => {
      const call = body.params[0] as Record<string, string>;
      const { functionName } = decodeFunctionData({ abi, data: call.data as Hex });
      return { json: { jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi, functionName, result: values[functionName] }) } };
    });
    expect(await readSpendingLimit(CONTRACT, { fetch })).toEqual({ state: "read", dailyUsdc: 5, weeklyUsdc: null, spentToday: 1.2, spentThisWeek: 3.7 });
  });

  it("says unreadable when any of it cannot be read", async () => {
    const { fetch } = node(() => ({ status: 500, json: {} }));
    expect(await readSpendingLimit(CONTRACT, { fetch })).toEqual({ state: "unreadable" });
  });
});
