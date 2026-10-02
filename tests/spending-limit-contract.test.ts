import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { compileSolidity } from "../scripts/solidity";
import { address, bytes32, selector, TestChain, uint } from "./support/evm";

/**
 * The spending limit contract (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md §2), run in an
 * in-process EVM against a plain ERC-20: only the agent pays, from the treasury, within the daily and 7-day
 * figures, and each payment's ref once; only the owner changes the figures. Also: the bytecode the app deploys
 * is the bytecode of this source, and it holds no PUSH0, which Arc testnet rejects.
 */

const artifact = JSON.parse(readFileSync("src/lib/spending-limit/artifact.json", "utf8")) as { abi: unknown[]; bytecode: string; settings: { evmVersion: string } };
const token = compileSolidity("tests/fixtures/TestToken.sol", "TestToken");

const TREASURY = `0x${"a1".repeat(20)}`;
const AGENT = `0x${"a9".repeat(20)}`;
const PAYEE = `0x${"b2".repeat(20)}`;
const STRANGER = `0x${"c3".repeat(20)}`;
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const DAY = BigInt(86_400);
// 2027-01-15 00:00:00 UTC plus ten hours: a time well inside a UTC day.
const NOW = BigInt(1_800_000_000) - (BigInt(1_800_000_000) % DAY) + 10n * 3600n;
const TODAY = NOW / DAY;

const errors = {
  NotAgent: selector("NotAgent()"),
  NotOwner: selector("NotOwner()"),
  OverDailyLimit: selector("OverDailyLimit(uint256,uint256,uint256)"),
  OverWeeklyLimit: selector("OverWeeklyLimit(uint256,uint256,uint256)"),
  AlreadyPaid: selector("AlreadyPaid(bytes32)"),
  InvalidLimits: selector("InvalidLimits()"),
  InvalidPayment: selector("InvalidPayment()"),
};

let chain: TestChain;
let usdc: string;
let limit: string;
let refs = 0;

const ref = () => `0x${(++refs).toString(16).padStart(64, "0")}`;
const balance = (who: string) => chain.readUint(usdc, "balanceOf(address)", [address(who)]);
const pay = (amount: bigint, from = AGENT, id = ref(), to = PAYEE) =>
  chain.call(limit, "pay(address,uint256,bytes32)", [address(to), uint(amount), bytes32(id)], from);
const setLimits = (daily: bigint, weekly: bigint, from = TREASURY) => chain.call(limit, "setLimits(uint256,uint256)", [uint(daily), uint(weekly)], from);
const topic = (signature: string) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex")}`;
/** The three uint256 arguments a figure's error carries: what was paid, the amount, the figure. */
const errorArgs = (returned: string) => (returned.slice(10).match(/.{64}/g) ?? []).map((word) => BigInt(`0x${word}`));

async function deploy(daily: bigint, weekly: bigint): Promise<string> {
  return chain.deploy(artifact.bytecode, [address(usdc), address(TREASURY), address(AGENT), uint(daily), uint(weekly)], TREASURY);
}

beforeEach(async () => {
  chain = await TestChain.start();
  chain.timestamp = NOW;
  usdc = await chain.deploy(token.bytecode, [], TREASURY);
  limit = await deploy(USDC(5), USDC(20));
  await chain.call(usdc, "mint(address,uint256)", [address(TREASURY), uint(USDC(100))], TREASURY);
  await chain.call(usdc, "approve(address,uint256)", [address(limit), uint(2n ** 256n - 1n)], TREASURY);
});

describe("VestiarionSpendingLimit: paying", () => {
  it("pays the agent's payment from the treasury, counts it against today, and records its ref", async () => {
    const id = ref();
    const paid = await pay(USDC(3), AGENT, id);
    expect(paid.reverted).toBe(false);
    expect(await balance(TREASURY)).toBe(USDC(97));
    expect(await balance(PAYEE)).toBe(USDC(3));
    expect(await balance(limit)).toBe(0n);
    expect(await chain.readUint(limit, "spentOn(uint256)", [uint(TODAY)])).toBe(USDC(3));
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(USDC(3));
    expect(await chain.readUint(limit, "spentThisWeek()", [])).toBe(USDC(3));
    expect((await chain.readWords(limit, "paid(bytes32)", [bytes32(id)]))[0]).toBe("1".padStart(64, "0"));
    const event = paid.logs.find((log) => log.address.toLowerCase() === limit.toLowerCase());
    expect(event?.topics[0]).toBe(topic("Paid(bytes32,address,uint256,uint256)"));
    expect(event?.topics[1]).toBe(id);
    expect(`0x${event?.topics[2].slice(26)}`).toBe(PAYEE);
  });

  it("refuses a payment past the daily figure, naming what was paid, the amount and the figure, and moves nothing", async () => {
    await pay(USDC(4));
    const refused = await pay(USDC(1.5));
    expect(refused.error).toBe(errors.OverDailyLimit);
    expect(errorArgs(refused.returned)).toEqual([USDC(4), USDC(1.5), USDC(5)]);
    expect(await balance(TREASURY)).toBe(USDC(96));
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(USDC(4));
    // Exactly up to the figure is allowed.
    expect((await pay(USDC(1))).reverted).toBe(false);
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(USDC(5));
  });

  it("starts each UTC day afresh for the daily figure", async () => {
    await pay(USDC(5));
    expect((await pay(USDC(0.01))).error).toBe(errors.OverDailyLimit);
    chain.timestamp = (TODAY + 1n) * DAY;
    expect((await pay(USDC(5))).reverted).toBe(false);
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(USDC(5));
    expect(await chain.readUint(limit, "spentThisWeek()", [])).toBe(USDC(10));
  });

  it("counts today and the six UTC days before it against the 7-day figure, and lets the oldest day drop out", async () => {
    for (let day = 0n; day < 4n; day += 1n) {
      chain.timestamp = (TODAY + day) * DAY + 3600n;
      expect((await pay(USDC(5))).reverted, `day ${day}`).toBe(false);
    }
    // 20 paid over four days: the 7-day figure is full.
    chain.timestamp = (TODAY + 4n) * DAY + 3600n;
    const refused = await pay(USDC(1));
    expect(refused.error).toBe(errors.OverWeeklyLimit);
    expect(errorArgs(refused.returned)).toEqual([USDC(20), USDC(1), USDC(20)]);
    // Seven days after the first payment, its day has left the window.
    chain.timestamp = (TODAY + 7n) * DAY + 3600n;
    expect(await chain.readUint(limit, "spentThisWeek()", [])).toBe(USDC(15));
    expect((await pay(USDC(5))).reverted).toBe(false);
    expect(await chain.readUint(limit, "spentThisWeek()", [])).toBe(USDC(20));
    // Today is full now too, and the daily figure is checked first.
    expect((await pay(USDC(0.5))).error).toBe(errors.OverDailyLimit);
  });

  it("answers only to the agent: not the treasury, not the payee, not anyone else", async () => {
    for (const caller of [TREASURY, PAYEE, STRANGER]) {
      expect((await pay(USDC(1), caller)).error, caller).toBe(errors.NotAgent);
    }
    expect(await balance(TREASURY)).toBe(USDC(100));
  });

  it("pays a ref once, even on another day", async () => {
    const id = ref();
    expect((await pay(USDC(1), AGENT, id)).reverted).toBe(false);
    const again = await pay(USDC(1), AGENT, id);
    expect(again.error).toBe(errors.AlreadyPaid);
    expect(`0x${again.returned.slice(10, 74)}`).toBe(id);
    chain.timestamp = (TODAY + 1n) * DAY;
    expect((await pay(USDC(1), AGENT, id)).error).toBe(errors.AlreadyPaid);
    expect(await balance(PAYEE)).toBe(USDC(1));
  });

  it("never pays nothing, or to no one", async () => {
    expect((await pay(0n)).error).toBe(errors.InvalidPayment);
    expect((await pay(USDC(1), AGENT, ref(), `0x${"0".repeat(40)}`)).error).toBe(errors.InvalidPayment);
  });

  it("records nothing when the treasury's approval does not cover the payment", async () => {
    await chain.call(usdc, "approve(address,uint256)", [address(limit), uint(0)], TREASURY);
    const id = ref();
    expect((await pay(USDC(1), AGENT, id)).reverted).toBe(true);
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(0n);
    expect((await chain.readWords(limit, "paid(bytes32)", [bytes32(id)]))[0]).toBe("0".repeat(64));
    expect(await balance(TREASURY)).toBe(USDC(100));
  });
});

describe("VestiarionSpendingLimit: the figures", () => {
  it("lets only the owner change them, and applies the new ones at once", async () => {
    await pay(USDC(5));
    for (const caller of [AGENT, PAYEE, STRANGER]) {
      expect((await setLimits(USDC(50), USDC(100), caller)).error, caller).toBe(errors.NotOwner);
    }
    const changed = await setLimits(USDC(8), USDC(100));
    expect(changed.reverted).toBe(false);
    expect(await chain.readUint(limit, "dailyLimit()", [])).toBe(USDC(8));
    expect(await chain.readUint(limit, "weeklyLimit()", [])).toBe(USDC(100));
    expect((await pay(USDC(3))).reverted).toBe(false);
    expect((await pay(USDC(0.01))).error).toBe(errors.OverDailyLimit);
  });

  it("takes 0 as a figure that is not set, but never both", async () => {
    expect((await setLimits(0n, USDC(6))).reverted).toBe(false);
    expect((await pay(USDC(6))).reverted).toBe(false);
    expect((await pay(USDC(0.01))).error).toBe(errors.OverWeeklyLimit);
    expect((await setLimits(USDC(6), 0n)).reverted).toBe(false);
    expect((await setLimits(0n, 0n)).error).toBe(errors.InvalidLimits);
  });

  it("refuses a 7-day figure below the daily one", async () => {
    expect((await setLimits(USDC(10), USDC(9))).error).toBe(errors.InvalidLimits);
    expect(await chain.readUint(limit, "dailyLimit()", [])).toBe(USDC(5));
  });

  it("names its token, treasury, owner and agent, and is never deployed without them or without a figure", async () => {
    const word = async (signature: string) => `0x${(await chain.readWords(limit, signature, []))[0].slice(24)}`;
    expect(await word("token()")).toBe(usdc.toLowerCase());
    expect(await word("treasury()")).toBe(TREASURY);
    expect(await word("owner()")).toBe(TREASURY);
    expect(await word("agent()")).toBe(AGENT);
    const zero = `0x${"0".repeat(40)}`;
    await expect(chain.deploy(artifact.bytecode, [address(usdc), address(zero), address(AGENT), uint(1), uint(1)], TREASURY)).rejects.toThrow(/deploy failed/);
    await expect(chain.deploy(artifact.bytecode, [address(usdc), address(TREASURY), address(zero), uint(1), uint(1)], TREASURY)).rejects.toThrow(/deploy failed/);
    await expect(deploy(0n, 0n)).rejects.toThrow(/deploy failed/);
    await expect(deploy(USDC(2), USDC(1))).rejects.toThrow(/deploy failed/);
  });
});

describe("the artifact the app deploys", () => {
  it("is what contracts/VestiarionSpendingLimit.sol compiles to, with the pinned settings", () => {
    const fresh = compileSolidity("contracts/VestiarionSpendingLimit.sol", "VestiarionSpendingLimit");
    expect(artifact.bytecode).toBe(fresh.bytecode);
    expect(artifact.abi).toEqual(fresh.abi);
    expect(artifact.settings.evmVersion).toBe("paris");
  });

  it("holds no PUSH0, which Arc testnet rejects", () => {
    const code = Buffer.from(artifact.bytecode.slice(2), "hex");
    for (let pc = 0; pc < code.length; pc += 1) {
      const op = code[pc];
      expect(op, `PUSH0 at ${pc}`).not.toBe(0x5f);
      if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f; // skip PUSH1..PUSH32 data
    }
  });
});
