import { createHash } from "node:crypto";
import { chainOn, homeChain } from "../payee-chains";
import { ARC_TESTNET, FeatureOffError, type NetworkProfile } from "../network";

/**
 * CCTP V2 from Arc testnet, with Circle's Forwarding Service
 * (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md). The operating
 * wallet approves TokenMessengerV2 and burns the invoice amount plus the fee
 * with the forwarding hook; Circle attests the burn and submits the mint on
 * the payee's chain itself, so there is no wallet or gas there to manage
 * (R1). Iris, Circle's attestation API, quotes the fee and reports the mint.
 */

/** Arc's USDC ERC-20 interface: 6 decimals, the native USDC's balance. */
export const ARC_TESTNET_USDC = ARC_TESTNET.tokens.USDC;
/** `depositForBurnWithHook`'s hook data asking the Forwarding Service to submit the mint ("cctp-forward"). */
export const CCTP_FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
/** Fast transfer: attested at "confirmed" finality, in seconds rather than minutes. */
export const FAST_FINALITY = 1000;
/** What a fast forwarded transfer takes end to end, as Circle documents it (8–20 s), rounded up. */
export const EXPECTED_BRIDGE_SECONDS = 30;

const IRIS_DEADLINE_MS = 10_000;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

/**
 * CCTP on a network (network threading P2, P5): its domain, Iris and the TokenMessenger a burn goes through. A network
 * without CCTP refuses by name, before any request.
 */
export function cctpOf(network: NetworkProfile): { domain: number; iris: string; tokenMessenger: string } {
  if (!network.cctp) throw new FeatureOffError("Paying through CCTP", network);
  return network.cctp;
}

export class BridgeFeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeFeeError";
  }
}

export interface BridgeFee {
  /** The fee on top of the invoice, in USDC: what the operating wallet pays to get the amount minted. */
  feeUsdc: number;
  /** The same, in base units: `depositForBurnWithHook`'s `maxFee`. */
  maxFeeUnits: bigint;
  /** CCTP's domain for the payee's chain. */
  domain: number;
}

const toUnits = (amount: number) => BigInt(Math.round(amount * 1_000_000));
const fromUnits = (units: bigint) => Number(units) / 1_000_000;

/**
 * The fee for paying `amount` USDC to a payee on `chain` from Arc, read from
 * Iris now: the forwarding fee (the high estimate, R3) plus the protocol's
 * minimum fee, in basis points of the amount.
 */
export async function bridgeFee(network: NetworkProfile, chain: string, amount: number, options: { fetch?: typeof fetch } = {}): Promise<BridgeFee> {
  const cctp = cctpOf(network);
  const target = chainOn(network.id, chain);
  if (target.id === homeChain(network.id).id) throw new Error(`A payee on ${network.label} is not paid across chains`);
  const domain = target.domain;
  if (domain === null) throw new BridgeFeeError(`CCTP has no domain for ${target.label}`);
  let rows: unknown;
  try {
    const response = await (options.fetch ?? fetch)(`${cctp.iris}/v2/burn/USDC/fees/${cctp.domain}/${domain}?forward=true`, {
      signal: AbortSignal.timeout(IRIS_DEADLINE_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new BridgeFeeError(`Iris answered ${response.status} for the fee to ${target.label}`);
    rows = await response.json();
  } catch (error) {
    if (error instanceof BridgeFeeError) throw error;
    throw new BridgeFeeError(`Iris did not answer for the fee to ${target.label}`);
  }
  const fast = Array.isArray(rows)
    ? (rows as Array<{ finalityThreshold?: number; minimumFee?: number; forwardFee?: { high?: number } }>).find((row) => row.finalityThreshold === FAST_FINALITY)
    : undefined;
  const forward = fast?.forwardFee?.high;
  if (!fast || typeof forward !== "number" || !Number.isFinite(forward) || forward < 0) {
    throw new BridgeFeeError(`Iris has no fast forwarded route to ${target.label}`);
  }
  const bps = typeof fast.minimumFee === "number" && fast.minimumFee > 0 ? fast.minimumFee : 0;
  const protocolUnits = (toUnits(amount) * BigInt(Math.round(bps * 100))) / BigInt(1_000_000);
  const maxFeeUnits = BigInt(Math.round(forward)) + protocolUnits;
  return { feeUsdc: fromUnits(maxFeeUnits), maxFeeUnits, domain };
}

/**
 * The Circle idempotency key for one step of a bridge, derived from the
 * payment attempt's key: the same attempt always sends the same approve and
 * the same burn, so a resubmission after an ambiguous outcome is answered
 * with the transaction Circle already created (X9). A UUID, as Circle requires.
 */
export function bridgeStepKey(attemptKey: string, step: "approve" | "burn"): string {
  const hash = createHash("sha256").update(`vestiarion/cctp/v1/${attemptKey}/${step}`, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** An EVM address as the 32 bytes CCTP takes for a recipient. */
export function toBytes32(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${address} is not an address`);
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

export interface ContractCall {
  contractAddress: string;
  abiFunctionSignature: string;
  abiParameters: string[];
}

/**
 * The operating wallet's two calls: approve TokenMessengerV2 for the amount
 * plus the fee, then burn both with the forwarding hook. The payee is minted
 * the amount; any part of `maxFee` not charged is minted to them too (R3).
 */
export function burnCalls(input: { amount: number; maxFeeUnits: bigint; domain: number; recipient: string; usdc: string; tokenMessenger: string }): [ContractCall, ContractCall] {
  const total = (toUnits(input.amount) + input.maxFeeUnits).toString();
  return [
    { contractAddress: input.usdc, abiFunctionSignature: "approve(address,uint256)", abiParameters: [input.tokenMessenger, total] },
    {
      contractAddress: input.tokenMessenger,
      abiFunctionSignature: "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
      abiParameters: [
        total,
        String(input.domain),
        toBytes32(input.recipient),
        input.usdc,
        ZERO_BYTES32,
        input.maxFeeUnits.toString(),
        String(FAST_FINALITY),
        CCTP_FORWARD_HOOK,
      ],
    },
  ];
}

/**
 * The mint the Forwarding Service submitted for a burn on Arc, by the burn's
 * transaction hash; null while there is none yet, or when Iris cannot say
 * (not found, an error, no answer): the payment then stays in flight (X8).
 */
export async function forwardedMint(network: NetworkProfile, burnTxHash: string, options: { fetch?: typeof fetch } = {}): Promise<{ mintTxHash: string } | null> {
  const cctp = cctpOf(network);
  try {
    const response = await (options.fetch ?? fetch)(`${cctp.iris}/v2/messages/${cctp.domain}?transactionHash=${burnTxHash}`, {
      signal: AbortSignal.timeout(IRIS_DEADLINE_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { messages?: Array<{ forwardTxHash?: unknown }> };
    const mint = body.messages?.find((message) => typeof message.forwardTxHash === "string" && message.forwardTxHash.length > 0)?.forwardTxHash;
    return typeof mint === "string" ? { mintTxHash: mint } : null;
  } catch {
    return null;
  }
}
