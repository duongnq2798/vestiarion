import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { compileSolidity } from "../scripts/solidity";
import { CCTP_FORWARD_HOOK } from "@/lib/circle/cctp-forward";
import { feeCapUnits, MAX_FEE_BPS, MAX_FEE_UNITS } from "@/lib/spending-limit/deployment";
import { address, bytes32, selector, TestChain, uint } from "./support/evm";

/**
 * Version 2 of the spending limit contract (docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-chain-design.md
 * V1–V6), run in an in-process EVM against a plain ERC-20 and a stand-in TokenMessengerV2: `payAcrossChains` pays only
 * for the agent, counts the amount and its fee against both figures, pays each ref once whichever function pays it,
 * burns only for its allowed domains with the forwarding hook, caps the fee, and never holds anything after a call.
 * Everything version 1 does is still done the same way.
 */

const artifact = (JSON.parse(readFileSync("src/lib/spending-limit/artifact.json", "utf8")) as { v2: { bytecode: string } }).v2;
const token = compileSolidity("tests/fixtures/TestToken.sol", "TestToken");
const messengerCode = compileSolidity("tests/fixtures/TestTokenMessenger.sol", "TestTokenMessenger");

const TREASURY = `0x${"a1".repeat(20)}`;
const AGENT = `0x${"a9".repeat(20)}`;
const PAYEE = `0x${"b2".repeat(20)}`;
const STRANGER = `0x${"c3".repeat(20)}`;
const RECIPIENT = `0x${"0".repeat(24)}${"b2".repeat(20)}`;
const BASE = 6;
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const DAY = BigInt(86_400);
const NOW = BigInt(1_800_000_000) - (BigInt(1_800_000_000) % DAY) + 10n * 3600n;
const TODAY = NOW / DAY;

const errors = {
  NotAgent: selector("NotAgent()"),
  NotOwner: selector("NotOwner()"),
  OverDailyLimit: selector("OverDailyLimit(uint256,uint256,uint256)"),
  OverWeeklyLimit: selector("OverWeeklyLimit(uint256,uint256,uint256)"),
  AlreadyPaid: selector("AlreadyPaid(bytes32)"),
  InvalidPayment: selector("InvalidPayment()"),
  DomainNotAllowed: selector("DomainNotAllowed(uint32)"),
  FeeTooHigh: selector("FeeTooHigh(uint256,uint256)"),
  BalanceLeft: selector("BalanceLeft()"),
};

let chain: TestChain;
let usdc: string;
let messenger: string;
let limit: string;
let refs = 0;

const ref = () => `0x${(++refs).toString(16).padStart(64, "0")}`;
const balance = (who: string) => chain.readUint(usdc, "balanceOf(address)", [address(who)]);
const across = (amount: bigint, maxFee: bigint, options: { from?: string; id?: string; domain?: number; recipient?: string } = {}) =>
  chain.call(
    limit,
    "payAcrossChains(uint256,uint256,uint32,bytes32,bytes32)",
    [uint(amount), uint(maxFee), uint(options.domain ?? BASE), bytes32(options.recipient ?? RECIPIENT), bytes32(options.id ?? ref())],
    options.from ?? AGENT
  );
const pay = (amount: bigint, id = ref()) => chain.call(limit, "pay(address,uint256,bytes32)", [address(PAYEE), uint(amount), bytes32(id)], AGENT);
const topic = (signature: string) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex")}`;
const errorArgs = (returned: string) => (returned.slice(10).match(/.{64}/g) ?? []).map((word) => BigInt(`0x${word}`));
const word = async (to: string, signature: string) => (await chain.readWords(to, signature, []))[0];

async function deploy(input: { messenger?: string; domains?: bigint; daily?: bigint; weekly?: bigint } = {}): Promise<string> {
  return chain.deploy(
    artifact.bytecode,
    [
      address(usdc),
      address(TREASURY),
      address(AGENT),
      address(input.messenger ?? messenger),
      uint(input.domains ?? 1n << BigInt(BASE)),
      uint(input.daily ?? USDC(5)),
      uint(input.weekly ?? USDC(20)),
    ],
    TREASURY
  );
}

beforeEach(async () => {
  chain = await TestChain.start();
  chain.timestamp = NOW;
  usdc = await chain.deploy(token.bytecode, [], TREASURY);
  messenger = await chain.deploy(messengerCode.bytecode, [], TREASURY);
  limit = await deploy();
  await chain.call(usdc, "mint(address,uint256)", [address(TREASURY), uint(USDC(1000))], TREASURY);
  await chain.call(usdc, "approve(address,uint256)", [address(limit), uint(2n ** 256n - 1n)], TREASURY);
});

describe("VestiarionSpendingLimitV2: paying across chains", () => {
  it("draws the amount and its fee from the treasury and burns both with the forwarding hook, keeping nothing", async () => {
    const id = ref();
    const paid = await across(USDC(3), USDC(0.06), { id });
    expect(paid.reverted).toBe(false);
    expect(await balance(TREASURY)).toBe(USDC(1000) - USDC(3.06));
    expect(await balance(messenger)).toBe(USDC(3.06));
    expect(await balance(limit)).toBe(0n);
    expect(await chain.readUint(usdc, "allowance(address,address)", [address(limit), address(messenger)])).toBe(0n);
    // The burn the operating wallet's bridge sends (CCTP payouts X2): the total, the domain, the recipient, USDC, any
    // caller, the fee, fast finality and "cctp-forward".
    expect(await chain.readUint(messenger, "lastAmount()", [])).toBe(USDC(3.06));
    expect(await chain.readUint(messenger, "lastDomain()", [])).toBe(BigInt(BASE));
    expect(`0x${await word(messenger, "lastRecipient()")}`).toBe(RECIPIENT);
    expect(`0x${(await word(messenger, "lastToken()")).slice(24)}`).toBe(usdc.toLowerCase());
    expect(await word(messenger, "lastCaller()")).toBe("0".repeat(64));
    expect(await chain.readUint(messenger, "lastMaxFee()", [])).toBe(USDC(0.06));
    expect(await chain.readUint(messenger, "lastFinality()", [])).toBe(1000n);
    expect(`0x${await word(messenger, "lastHook()")}`).toBe(CCTP_FORWARD_HOOK);
    expect(await chain.readUint(messenger, "hookLength()", [])).toBe(32n);
    // Counted with its fee, and its ref paid.
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(USDC(3.06));
    expect(await chain.readUint(limit, "spentOn(uint256)", [uint(TODAY)])).toBe(USDC(3.06));
    expect((await chain.readWords(limit, "paid(bytes32)", [bytes32(id)]))[0]).toBe("1".padStart(64, "0"));
    const event = paid.logs.find((log) => log.address.toLowerCase() === limit.toLowerCase());
    expect(event?.topics[0]).toBe(topic("PaidAcrossChains(bytes32,uint32,bytes32,uint256,uint256,uint256)"));
    expect(event?.topics[1]).toBe(id);
    expect(BigInt(event?.topics[2] ?? "0x0")).toBe(BigInt(BASE));
    expect(errorArgs(`0x00000000${event?.data.slice(2)}`)).toEqual([BigInt(RECIPIENT), USDC(3), USDC(0.06), TODAY]);
  });

  it("counts the amount and its fee against the daily figure, and refuses past it with what the contract counts", async () => {
    expect((await across(USDC(4), USDC(0.4))).reverted).toBe(false);
    const refused = await across(USDC(0.6), USDC(0.01));
    expect(refused.error).toBe(errors.OverDailyLimit);
    expect(errorArgs(refused.returned)).toEqual([USDC(4.4), USDC(0.61), USDC(5)]);
    expect(await balance(TREASURY)).toBe(USDC(1000) - USDC(4.4));
    // Up to the figure exactly, fee included.
    expect((await across(USDC(0.59), USDC(0.01))).reverted).toBe(false);
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(USDC(5));
  });

  it("counts payouts across chains and payments on Arc against the same 7-day figure", async () => {
    for (let day = 0n; day < 3n; day += 1n) {
      chain.timestamp = (TODAY + day) * DAY + 3600n;
      expect((await pay(USDC(5))).reverted, `day ${day}`).toBe(false);
    }
    chain.timestamp = (TODAY + 3n) * DAY + 3600n;
    expect((await across(USDC(2.5), USDC(0.25))).reverted).toBe(false);
    // The next day: 2.2 that day, well inside the daily figure; 19.95 over the 7 days.
    chain.timestamp = (TODAY + 4n) * DAY + 3600n;
    expect((await across(USDC(2), USDC(0.2))).reverted).toBe(false);
    const refused = await across(USDC(0.5), USDC(0.05));
    expect(refused.error).toBe(errors.OverWeeklyLimit);
    expect(errorArgs(refused.returned)).toEqual([USDC(19.95), USDC(0.55), USDC(20)]);
  });

  it("answers only to the agent", async () => {
    for (const from of [TREASURY, PAYEE, STRANGER]) {
      expect((await across(USDC(1), 0n, { from })).error, from).toBe(errors.NotAgent);
    }
    expect(await balance(TREASURY)).toBe(USDC(1000));
  });

  it("pays a ref once, whichever function pays it", async () => {
    const first = ref();
    expect((await pay(USDC(1), first)).reverted).toBe(false);
    const again = await across(USDC(1), 0n, { id: first });
    expect(again.error).toBe(errors.AlreadyPaid);
    expect(`0x${again.returned.slice(10, 74)}`).toBe(first);
    const second = ref();
    expect((await across(USDC(1), 0n, { id: second })).reverted).toBe(false);
    expect((await pay(USDC(1), second)).error).toBe(errors.AlreadyPaid);
    expect((await across(USDC(1), 0n, { id: second })).error).toBe(errors.AlreadyPaid);
    expect(await chain.readUint(messenger, "burns()", [])).toBe(1n);
  });

  it("burns only for the domains it was deployed with", async () => {
    for (const domain of [0, 3, 26, 300]) {
      const refused = await across(USDC(1), 0n, { domain });
      expect(refused.error, `domain ${domain}`).toBe(errors.DomainNotAllowed);
      expect(errorArgs(refused.returned)).toEqual([BigInt(domain)]);
    }
    const several = await deploy({ domains: (1n << 0n) | (1n << 6n) });
    await chain.call(usdc, "approve(address,uint256)", [address(several), uint(USDC(100))], TREASURY);
    const viaSeveral = (domain: number) =>
      chain.call(several, "payAcrossChains(uint256,uint256,uint32,bytes32,bytes32)", [uint(USDC(1)), uint(0), uint(domain), bytes32(RECIPIENT), bytes32(ref())], AGENT);
    expect((await viaSeveral(0)).reverted).toBe(false);
    expect((await viaSeveral(6)).reverted).toBe(false);
    expect((await viaSeveral(3)).error).toBe(errors.DomainNotAllowed);
  });

  it("caps the fee at 10% of the amount and at 2 USDC", async () => {
    expect(MAX_FEE_BPS).toBe(await chain.readUint(limit, "MAX_FEE_BPS()", []));
    expect(MAX_FEE_UNITS).toBe(await chain.readUint(limit, "MAX_FEE_UNITS()", []));
    const tooMuch = await across(USDC(1), USDC(0.100001));
    expect(tooMuch.error).toBe(errors.FeeTooHigh);
    expect(errorArgs(tooMuch.returned)).toEqual([USDC(0.100001), USDC(0.1)]);
    expect((await across(USDC(1), USDC(0.1))).reverted).toBe(false);
    // Past 20 USDC, the 2 USDC cap is the lower one.
    const big = await deploy({ daily: USDC(500), weekly: USDC(500) });
    await chain.call(usdc, "approve(address,uint256)", [address(big), uint(USDC(500))], TREASURY);
    const viaBig = (amount: bigint, fee: bigint) =>
      chain.call(big, "payAcrossChains(uint256,uint256,uint32,bytes32,bytes32)", [uint(amount), uint(fee), uint(BASE), bytes32(RECIPIENT), bytes32(ref())], AGENT);
    const refused = await viaBig(USDC(100), USDC(2.000001));
    expect(refused.error).toBe(errors.FeeTooHigh);
    expect(errorArgs(refused.returned)).toEqual([USDC(2.000001), USDC(2)]);
    expect((await viaBig(USDC(100), USDC(2))).reverted).toBe(false);
    expect(feeCapUnits(USDC(100))).toBe(USDC(2));
    expect(feeCapUnits(USDC(1))).toBe(USDC(0.1));
  });

  it("never pays nothing, or to no one", async () => {
    expect((await across(0n, 0n)).error).toBe(errors.InvalidPayment);
    expect((await across(USDC(1), 0n, { recipient: `0x${"0".repeat(64)}` })).error).toBe(errors.InvalidPayment);
  });

  it("refuses the whole call, recording nothing, when it would be left holding USDC", async () => {
    await chain.call(messenger, "setPullShort(bool)", [uint(1)], TREASURY);
    const id = ref();
    const refused = await across(USDC(1), USDC(0.05), { id });
    expect(refused.error).toBe(errors.BalanceLeft);
    expect(await balance(TREASURY)).toBe(USDC(1000));
    expect(await balance(limit)).toBe(0n);
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(0n);
    expect((await chain.readWords(limit, "paid(bytes32)", [bytes32(id)]))[0]).toBe("0".repeat(64));
  });

  it("leaves USDC someone sent it as it was, and still keeps none of a payout", async () => {
    await chain.call(usdc, "mint(address,uint256)", [address(limit), uint(USDC(0.5))], TREASURY);
    expect((await across(USDC(1), USDC(0.05))).reverted).toBe(false);
    expect(await balance(limit)).toBe(USDC(0.5));
    expect(await balance(messenger)).toBe(USDC(1.05));
  });

  it("records nothing when the treasury's approval does not cover the amount and its fee", async () => {
    await chain.call(usdc, "approve(address,uint256)", [address(limit), uint(USDC(1))], TREASURY);
    const id = ref();
    expect((await across(USDC(1), USDC(0.05), { id })).reverted).toBe(true);
    expect(await chain.readUint(limit, "spentToday()", [])).toBe(0n);
    expect((await chain.readWords(limit, "paid(bytes32)", [bytes32(id)]))[0]).toBe("0".repeat(64));
  });
});

describe("VestiarionSpendingLimitV2: what version 1 does", () => {
  it("pays on Arc from the treasury within the figures, as version 1 does", async () => {
    const paid = await pay(USDC(3));
    expect(paid.reverted).toBe(false);
    expect(await balance(PAYEE)).toBe(USDC(3));
    expect(await balance(limit)).toBe(0n);
    const event = paid.logs.find((log) => log.address.toLowerCase() === limit.toLowerCase());
    expect(event?.topics[0]).toBe(topic("Paid(bytes32,address,uint256,uint256)"));
    const refused = await pay(USDC(2.5));
    expect(refused.error).toBe(errors.OverDailyLimit);
    expect(errorArgs(refused.returned)).toEqual([USDC(3), USDC(2.5), USDC(5)]);
  });

  it("lets only the owner change the figures", async () => {
    for (const caller of [AGENT, PAYEE, STRANGER]) {
      expect((await chain.call(limit, "setLimits(uint256,uint256)", [uint(USDC(9)), uint(USDC(90))], caller)).error).toBe(errors.NotOwner);
    }
    expect((await chain.call(limit, "setLimits(uint256,uint256)", [uint(USDC(9)), uint(USDC(90))], TREASURY)).reverted).toBe(false);
    expect(await chain.readUint(limit, "dailyLimit()", [])).toBe(USDC(9));
  });

  it("says it is version 2, names its messenger and domains, and is never deployed without a messenger", async () => {
    expect(await chain.readUint(limit, "VERSION()", [])).toBe(2n);
    expect(`0x${(await word(limit, "tokenMessenger()")).slice(24)}`).toBe(messenger.toLowerCase());
    expect(await chain.readUint(limit, "allowedDomains()", [])).toBe(1n << 6n);
    expect(`0x${(await word(limit, "agent()")).slice(24)}`).toBe(AGENT);
    await expect(deploy({ messenger: `0x${"0".repeat(40)}` })).rejects.toThrow(/deploy failed/);
    await expect(deploy({ daily: 0n, weekly: 0n })).rejects.toThrow(/deploy failed/);
  });
});
