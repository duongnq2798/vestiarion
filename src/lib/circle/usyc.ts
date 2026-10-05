import crypto from "node:crypto";
import { decodeFunctionResult, encodeFunctionData, parseAbi, toFunctionSelector, type Hex } from "viem";
import { FeatureOffError, type NetworkProfile } from "../network";

/**
 * USYC on Arc testnet (docs/superpowers/specs/2026-10-02-usyc-live-design.md): Circle's tokenized
 * money market fund, bought and sold through its Teller, open only to allowlisted wallets. Every read
 * here is an `eth_call` to Arc testnet; nothing is sent. Amounts are base units: USDC and USYC both
 * have 6 decimals, and the oracle's price has 18.
 */

/**
 * USYC on a network (docs/superpowers/specs/2026-10-05-network-threading-design.md P2, P5): its token, Teller and
 * entitlements. A network without the real reserve refuses by name, before any read.
 */
export function usycOf(network: NetworkProfile): { token: string; teller: string; entitlements: string } {
  if (!network.usyc) throw new FeatureOffError("The USYC reserve", network);
  return network.usyc;
}

const PRICE_SCALE = 10n ** 18n;
const UNITS = 1_000_000;

const TELLER_ABI = parseAbi([
  "function mintPrice() view returns (int256)",
  "function oracle() view returns (address)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address account) returns (uint256)",
]);
const ORACLE_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ENTITLEMENTS_ABI = parseAbi(["function canCall(address user, address target, bytes4 functionSig) view returns (bool)"]);

export const DEPOSIT_SIGNATURE = "deposit(uint256,address)";
export const REDEEM_SIGNATURE = "redeem(uint256,address,address)";

/** Where a USYC read goes: the network's contracts, at its RPC. */
export interface UsycRead {
  network: NetworkProfile;
  rpcUrl: string;
  fetch?: typeof fetch;
}

async function call(to: string, data: Hex, options: UsycRead): Promise<Hex> {
  const response = await (options.fetch ?? fetch)(options.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(6_000),
    cache: "no-store",
  });
  const answer = (await response.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || typeof answer.result !== "string" || !answer.result.startsWith("0x")) {
    throw new Error(`${options.network.label} did not answer a USYC read${answer.error?.message ? `: ${answer.error.message}` : ""}`);
  }
  return answer.result as Hex;
}

/** USYC's latest price in USDC, as the oracle the Teller reads it from has it (18 decimals). */
export async function readUsycPrice(options: UsycRead): Promise<bigint> {
  const oracle = await oracleAddress(options);
  const round = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: "latestRoundData",
    data: await call(oracle, encodeFunctionData({ abi: ORACLE_ABI, functionName: "latestRoundData" }), options),
  });
  const price = round[1];
  if (price <= 0n) throw new Error("USYC's oracle has no price");
  return price;
}

async function oracleAddress(options: UsycRead): Promise<Hex> {
  const { teller } = usycOf(options.network);
  return decodeFunctionResult({
    abi: TELLER_ABI,
    functionName: "oracle",
    data: await call(teller, encodeFunctionData({ abi: TELLER_ABI, functionName: "oracle" }), options),
  });
}

const DAY_SECONDS = 86_400n;

/**
 * The fund's yield a year, from the oracle's own history: the latest price against the newest round at
 * least `minDays` older, annualized. A round more than 5% from the latest price is skipped as a bad
 * print (Arc testnet's oracle once posted 154 USDC for a day). Null when no round fits; the reserve
 * then keeps the yield it had. It replaces a configured figure, which for a hosted workspace was 0.
 */
export async function readUsycApy(options: UsycRead & { minDays?: number; maxRounds?: number }): Promise<number | null> {
  const oracle = await oracleAddress(options);
  const latest = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: "latestRoundData",
    data: await call(oracle, encodeFunctionData({ abi: ORACLE_ABI, functionName: "latestRoundData" }), options),
  });
  const [roundId, price, , updatedAt] = latest;
  if (price <= 0n) return null;
  const minSeconds = BigInt(options.minDays ?? 5) * DAY_SECONDS;
  for (let back = 1n; back <= BigInt(options.maxRounds ?? 12) && back < roundId; back += 1n) {
    const round = decodeFunctionResult({
      abi: ORACLE_ABI,
      functionName: "getRoundData",
      data: await call(oracle, encodeFunctionData({ abi: ORACLE_ABI, functionName: "getRoundData", args: [roundId - back] }), options),
    });
    const [, earlier, , at] = round;
    if (earlier <= 0n || updatedAt - at < minSeconds) continue;
    const ratio = Number(price) / Number(earlier);
    if (Math.abs(ratio - 1) > 0.05) continue;
    const years = Number(updatedAt - at) / (365 * 86_400);
    const apy = Math.pow(ratio, 1 / years) - 1;
    return apy >= 0 && apy < 1 ? Math.round(apy * 10_000) / 10_000 : null;
  }
  return null;
}

/**
 * Whether USYC can be bought now (R4). The Teller mints at the day's price only between the oracle's
 * daily update and 14:00 New York time; outside that, its mint price is 0 and a deposit reverts.
 */
export async function usycSubscriptionsOpen(options: UsycRead): Promise<boolean> {
  const { teller } = usycOf(options.network);
  const price = decodeFunctionResult({
    abi: TELLER_ABI,
    functionName: "mintPrice",
    data: await call(teller, encodeFunctionData({ abi: TELLER_ABI, functionName: "mintPrice" }), options),
  });
  return price > 0n;
}

/** The USYC an address holds, in base units. */
export async function readUsycShares(address: string, options: UsycRead): Promise<bigint> {
  const { token } = usycOf(options.network);
  return decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: await call(token, encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [address as Hex] }), options),
  });
}

async function canCall(user: string, signature: string, options: UsycRead): Promise<boolean> {
  const { entitlements, teller } = usycOf(options.network);
  return decodeFunctionResult({
    abi: ENTITLEMENTS_ABI,
    functionName: "canCall",
    data: await call(
      entitlements,
      encodeFunctionData({ abi: ENTITLEMENTS_ABI, functionName: "canCall", args: [user as Hex, teller as Hex, toFunctionSelector(signature)] }),
      options
    ),
  });
}

/** Whether Circle has allowlisted the wallets for their part (R1): the operating one to buy, the reserve one to sell. */
export async function usycEntitlements(wallets: { operating: string; reserve: string }, options: UsycRead): Promise<{ operating: boolean; reserve: boolean }> {
  usycOf(options.network);
  const [operating, reserve] = await Promise.all([canCall(wallets.operating, DEPOSIT_SIGNATURE, options), canCall(wallets.reserve, REDEEM_SIGNATURE, options)]);
  return { operating, reserve };
}

/** A USDC amount in base units, from its decimal value, without a float multiply drifting it. */
export function toUnits(amount: number): bigint {
  return BigInt(Math.round(amount * UNITS));
}

/** Base units back to a decimal USDC or USYC amount. */
export function fromUnits(units: bigint): number {
  return Number(units) / UNITS;
}

/** What `shares` USYC are worth in USDC at `price`, rounded down, in base units. */
export function sharesValue(shares: bigint, price: bigint): bigint {
  return (shares * price) / PRICE_SCALE;
}

/** The whole USYC that cover `assets` USDC at `price`, rounded up, never more than `held` (R5). */
export function sharesToRedeem(assets: bigint, price: bigint, held: bigint): bigint {
  const needed = (assets * PRICE_SCALE + price - 1n) / price;
  return needed < held ? needed : held;
}

/** A USYC move's Circle idempotency key, a UUID from its seed, as a swap's steps are (`swapStepKey`). */
export function usycStepKey(seed: string): string {
  const bytes = crypto.createHash("sha256").update(`vestiarion/usyc/v1/${seed}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A sweep refused because USYC cannot be bought now (R4). The treasury stage records it as not executed, with this sentence. */
export class UsycSubscriptionsClosedError extends Error {
  constructor() {
    super("USYC can be bought only between its daily price update and 14:00 New York time on business days; nothing was moved");
    this.name = "UsycSubscriptionsClosedError";
  }
}

/**
 * A USYC call Circle took that Arc testnet had not confirmed within the wait: it may still land. Asking again under the
 * same key finds the same call rather than sending a second one (approval cash review finding 1).
 */
export class UsycNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsycNotConfirmedError";
  }
}

/** The decimal price, for the ledger and the console: 1.138897 USDC per USYC. */
export function priceValue(price: bigint): number {
  return Number(price / 10n ** 12n) / UNITS;
}
