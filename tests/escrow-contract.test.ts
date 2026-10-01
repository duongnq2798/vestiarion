import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { compileSolidity } from "../scripts/solidity";
import { address, bytes32, selector, TestChain, uint } from "./support/evm";

/**
 * The milestone escrow contract (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E1, R4), run in
 * an in-process EVM against a plain ERC-20: the payer locks a hold for a payee; the hold is released to its
 * payee, or refunded to the payer from its refund date; once, and only by the payer. Also: the bytecode the
 * app deploys is the bytecode of this source, and it holds no PUSH0, which Arc testnet rejects.
 */

const artifact = JSON.parse(readFileSync("src/lib/escrow/artifact.json", "utf8")) as { abi: unknown[]; bytecode: string; settings: { evmVersion: string } };
const token = compileSolidity("tests/fixtures/TestToken.sol", "TestToken");

const PAYER = `0x${"a1".repeat(20)}`;
const PAYEE = `0x${"b2".repeat(20)}`;
const STRANGER = `0x${"c3".repeat(20)}`;
const ID = `0x${"0b6c1c9e4a4f4a7e9b1e0000000001aa".padEnd(64, "0")}`;
const AMOUNT = BigInt(2_000_000);
const NOW = BigInt(1_800_000_000);
const DAY = BigInt(86_400);

const errors = {
  NotPayer: selector("NotPayer()"),
  HoldExists: selector("HoldExists()"),
  NotFunded: selector("NotFunded()"),
  InvalidHold: selector("InvalidHold()"),
  TooEarly: selector("TooEarly()"),
};

let chain: TestChain;
let usdc: string;
let escrow: string;

const balance = (who: string) => chain.readUint(usdc, "balanceOf(address)", [address(who)]);
const fund = (from = PAYER, id = ID, payee = PAYEE, amount = AMOUNT, refundAfter = NOW + 30n * DAY) =>
  chain.call(escrow, "fund(bytes32,address,uint256,uint64)", [bytes32(id), address(payee), uint(amount), uint(refundAfter)], from);

beforeEach(async () => {
  chain = await TestChain.start();
  chain.timestamp = NOW;
  usdc = await chain.deploy(token.bytecode, [], PAYER);
  escrow = await chain.deploy(artifact.bytecode, [address(usdc), address(PAYER)], PAYER);
  await chain.call(usdc, "mint(address,uint256)", [address(PAYER), uint(10_000_000)], PAYER);
  await chain.call(usdc, "approve(address,uint256)", [address(escrow), uint(AMOUNT)], PAYER);
});

describe("VestiarionEscrow", () => {
  it("locks a hold: the amount moves from the payer into the escrow, and the hold names its payee", async () => {
    const funded = await fund();
    expect(funded.reverted).toBe(false);
    expect(await balance(PAYER)).toBe(BigInt(8_000_000));
    expect(await balance(escrow)).toBe(AMOUNT);
    const [payee, refundAfter, state, amount] = await chain.readWords(escrow, "holds(bytes32)", [bytes32(ID)]);
    expect(`0x${payee.slice(24)}`).toBe(PAYEE);
    expect(BigInt(`0x${refundAfter}`)).toBe(NOW + 30n * DAY);
    expect(BigInt(`0x${state}`)).toBe(1n);
    expect(BigInt(`0x${amount}`)).toBe(AMOUNT);
    expect(funded.logs.some((log) => log.address.toLowerCase() === escrow.toLowerCase() && log.topics[1] === ID)).toBe(true);
  });

  it("releases a hold to its payee, once", async () => {
    await fund();
    const released = await chain.call(escrow, "release(bytes32)", [bytes32(ID)], PAYER);
    expect(released.reverted).toBe(false);
    expect(await balance(PAYEE)).toBe(AMOUNT);
    expect(await balance(escrow)).toBe(0n);
    expect((await chain.call(escrow, "release(bytes32)", [bytes32(ID)], PAYER)).error).toBe(errors.NotFunded);
    expect((await chain.call(escrow, "refund(bytes32)", [bytes32(ID)], PAYER)).error).toBe(errors.NotFunded);
  });

  it("refunds a hold to the payer only from its refund date, and then never releases it", async () => {
    await fund();
    chain.timestamp = NOW + 30n * DAY - 1n;
    expect((await chain.call(escrow, "refund(bytes32)", [bytes32(ID)], PAYER)).error).toBe(errors.TooEarly);
    chain.timestamp = NOW + 30n * DAY;
    expect((await chain.call(escrow, "refund(bytes32)", [bytes32(ID)], PAYER)).reverted).toBe(false);
    expect(await balance(PAYER)).toBe(BigInt(10_000_000));
    expect((await chain.call(escrow, "release(bytes32)", [bytes32(ID)], PAYER)).error).toBe(errors.NotFunded);
  });

  it("answers only to the payer: not the payee, not anyone else", async () => {
    await fund();
    for (const caller of [PAYEE, STRANGER]) {
      expect((await chain.call(escrow, "release(bytes32)", [bytes32(ID)], caller)).error).toBe(errors.NotPayer);
      expect((await chain.call(escrow, "refund(bytes32)", [bytes32(ID)], caller)).error).toBe(errors.NotPayer);
    }
    expect((await fund(STRANGER, `0x${"1".repeat(64)}`)).error).toBe(errors.NotPayer);
    expect(await balance(escrow)).toBe(AMOUNT);
  });

  it("funds an id once, and never a hold with no payee or no amount", async () => {
    await fund();
    await chain.call(usdc, "approve(address,uint256)", [address(escrow), uint(AMOUNT)], PAYER);
    expect((await fund()).error).toBe(errors.HoldExists);
    expect((await fund(PAYER, `0x${"2".repeat(64)}`, `0x${"0".repeat(40)}`)).error).toBe(errors.InvalidHold);
    expect((await fund(PAYER, `0x${"3".repeat(64)}`, PAYEE, 0n)).error).toBe(errors.InvalidHold);
  });

  it("moves nothing when the payer did not approve the amount", async () => {
    await chain.call(usdc, "approve(address,uint256)", [address(escrow), uint(0)], PAYER);
    expect((await fund()).reverted).toBe(true);
    expect(await balance(escrow)).toBe(0n);
    const [, , state] = await chain.readWords(escrow, "holds(bytes32)", [bytes32(ID)]);
    expect(BigInt(`0x${state}`)).toBe(0n);
  });

  it("names its token and its payer, and is never deployed without them", async () => {
    expect(`0x${(await chain.readWords(escrow, "payer()", []))[0].slice(24)}`).toBe(PAYER);
    expect(`0x${(await chain.readWords(escrow, "token()", []))[0].slice(24)}`).toBe(usdc.toLowerCase());
    await expect(chain.deploy(artifact.bytecode, [address(`0x${"0".repeat(40)}`), address(PAYER)], PAYER)).rejects.toThrow(/deploy failed/);
  });
});

describe("the artifact the app deploys", () => {
  it("is what contracts/VestiarionEscrow.sol compiles to, with the pinned settings", () => {
    const fresh = compileSolidity("contracts/VestiarionEscrow.sol", "VestiarionEscrow");
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
