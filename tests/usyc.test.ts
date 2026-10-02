import { decodeFunctionData, encodeAbiParameters, parseAbi, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARC_TESTNET_USYC,
  fromUnits,
  priceValue,
  readUsycPrice,
  readUsycShares,
  sharesToRedeem,
  sharesValue,
  toUnits,
  USYC_ENTITLEMENTS,
  USYC_TELLER,
  usycEntitlements,
  usycSubscriptionsOpen,
} from "@/lib/circle/usyc";

/** USYC on Arc testnet, read with eth_call (docs/superpowers/specs/2026-10-02-usyc-live-design.md §2, R1, R4, R5). */

const ORACLE = "0x52b56c7642E71dc54714d879127d97cd0B3D4581";
const PRICE = 1_138_897_837_595_301_387n; // 1.138897… USDC per USYC, as read on 2026-10-01
const OPERATING = "0x97f85033bbd83870a841cf7153f35b387746b6b6";
const RESERVE = "0xa8a4ced0cda82b24d11e0386f066eb8c27fd4887";

const ABI = parseAbi([
  "function mintPrice() view returns (int256)",
  "function oracle() view returns (address)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function balanceOf(address) view returns (uint256)",
  "function canCall(address user, address target, bytes4 functionSig) view returns (bool)",
]);

/** An Arc node that answers the reads these functions make, and records them. */
function node(state: { mintPrice?: bigint; shares?: bigint; allowed?: string[]; fail?: boolean } = {}) {
  const calls: Array<{ to: string; fn: string; args: readonly unknown[] }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (state.fail) return new Response(JSON.stringify({ error: { message: "execution reverted" } }), { status: 200 });
    const { params } = JSON.parse(String(init.body)) as { params: [{ to: string; data: Hex }] };
    const { to, data } = params[0];
    const decoded = decodeFunctionData({ abi: ABI, data });
    calls.push({ to, fn: decoded.functionName, args: decoded.args ?? [] });
    const answer = (): Hex => {
      switch (decoded.functionName) {
        case "oracle":
          return encodeAbiParameters([{ type: "address" }], [ORACLE]);
        case "latestRoundData":
          return encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [159n, PRICE, 0n, 1_790_000_000n, 159n]);
        case "mintPrice":
          return encodeAbiParameters([{ type: "int256" }], [state.mintPrice ?? 0n]);
        case "balanceOf":
          return encodeAbiParameters([{ type: "uint256" }], [state.shares ?? 0n]);
        case "canCall": {
          const [user, , sig] = decoded.args as [string, string, string];
          return encodeAbiParameters([{ type: "bool" }], [(state.allowed ?? []).includes(`${user.toLowerCase()}:${sig}`)]);
        }
      }
    };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer() }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("reading USYC on Arc testnet", () => {
  it("reads the price from the oracle the Teller names", async () => {
    const arc = node();
    expect(await readUsycPrice({ fetch: arc.fetch })).toBe(PRICE);
    expect(arc.calls.map((c) => [c.to, c.fn])).toEqual([[USYC_TELLER, "oracle"], [ORACLE, "latestRoundData"]]);
  });

  it("knows subscriptions are open only while the Teller has a mint price (R4)", async () => {
    expect(await usycSubscriptionsOpen({ fetch: node({ mintPrice: PRICE }).fetch })).toBe(true);
    expect(await usycSubscriptionsOpen({ fetch: node({ mintPrice: 0n }).fetch })).toBe(false);
  });

  it("reads an address's USYC", async () => {
    const arc = node({ shares: 5_000_000n });
    expect(await readUsycShares(RESERVE, { fetch: arc.fetch })).toBe(5_000_000n);
    expect(arc.calls[0]).toMatchObject({ to: ARC_TESTNET_USYC, fn: "balanceOf" });
  });

  it("asks the Entitlements contract whether operating may deposit and reserve may redeem (R1)", async () => {
    const deposit = toFunctionSelector("deposit(uint256,address)");
    const redeem = toFunctionSelector("redeem(uint256,address,address)");
    const both = node({ allowed: [`${OPERATING}:${deposit}`, `${RESERVE}:${redeem}`] });
    expect(await usycEntitlements({ operating: OPERATING, reserve: RESERVE }, { fetch: both.fetch })).toEqual({ operating: true, reserve: true });
    expect(both.calls.every((c) => c.to === USYC_ENTITLEMENTS && (c.args as string[])[1] === USYC_TELLER)).toBe(true);
    const onlyOperating = node({ allowed: [`${OPERATING}:${deposit}`] });
    expect(await usycEntitlements({ operating: OPERATING, reserve: RESERVE }, { fetch: onlyOperating.fetch })).toEqual({ operating: true, reserve: false });
  });

  it("throws when Arc does not answer, rather than reading a zero", async () => {
    await expect(readUsycShares(RESERVE, { fetch: node({ fail: true }).fetch })).rejects.toThrow(/did not answer a USYC read: execution reverted/);
  });
});

describe("USYC arithmetic", () => {
  it("values shares at the price, rounding down", () => {
    expect(sharesValue(5_000_000n, PRICE)).toBe(5_694_489n);
    expect(fromUnits(sharesValue(1_000_000n, PRICE))).toBe(1.138897);
  });

  it("redeems the whole shares that cover the USDC asked, rounding up, never more than held (R5)", () => {
    const shares = sharesToRedeem(toUnits(10), PRICE, 100_000_000n);
    expect(sharesValue(shares, PRICE)).toBeGreaterThanOrEqual(10_000_000n);
    expect(sharesValue(shares - 1n, PRICE)).toBeLessThan(10_000_000n);
    expect(sharesToRedeem(toUnits(10), PRICE, 3_000_000n)).toBe(3_000_000n);
  });

  it("converts amounts without a float drifting them", () => {
    expect(toUnits(0.1 + 0.2)).toBe(300_000n);
    expect(priceValue(PRICE)).toBe(1.138897);
  });
});
