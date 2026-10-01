import { payeeChain, type PayeeChain } from "../payee-chains";

/**
 * CCTP V2 from Arc testnet, with Circle's Forwarding Service
 * (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md). The operating
 * wallet approves TokenMessengerV2 and burns the invoice amount plus the fee
 * with the forwarding hook; Circle attests the burn and submits the mint on
 * the payee's chain itself, so there is no wallet or gas there to manage
 * (R1). Iris, Circle's attestation API, quotes the fee and reports the mint.
 */

export const ARC_TESTNET_DOMAIN = 26;
/** TokenMessengerV2: the same address on every CCTP testnet, Arc's included. */
export const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
/** Arc's USDC ERC-20 interface: 6 decimals, the native USDC's balance. */
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
/** `depositForBurnWithHook`'s hook data asking the Forwarding Service to submit the mint ("cctp-forward"). */
export const CCTP_FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
/** Fast transfer: attested at "confirmed" finality, in seconds rather than minutes. */
export const FAST_FINALITY = 1000;
/** What a fast forwarded transfer takes end to end, as Circle documents it (8–20 s), rounded up. */
export const EXPECTED_BRIDGE_SECONDS = 30;

const IRIS = "https://iris-api-sandbox.circle.com";
const IRIS_DEADLINE_MS = 10_000;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

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
export async function bridgeFee(chain: PayeeChain | string, amount: number, options: { fetch?: typeof fetch } = {}): Promise<BridgeFee> {
  const target = payeeChain(chain);
  if (target.id === "ARC-TESTNET") throw new Error("A payee on Arc testnet is not paid across chains");
  let rows: unknown;
  try {
    const response = await (options.fetch ?? fetch)(`${IRIS}/v2/burn/USDC/fees/${ARC_TESTNET_DOMAIN}/${target.domain}?forward=true`, {
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
  return { feeUsdc: fromUnits(maxFeeUnits), maxFeeUnits, domain: target.domain };
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
export function burnCalls(input: { amount: number; maxFeeUnits: bigint; domain: number; recipient: string }): [ContractCall, ContractCall] {
  const total = (toUnits(input.amount) + input.maxFeeUnits).toString();
  return [
    { contractAddress: ARC_TESTNET_USDC, abiFunctionSignature: "approve(address,uint256)", abiParameters: [TOKEN_MESSENGER_V2, total] },
    {
      contractAddress: TOKEN_MESSENGER_V2,
      abiFunctionSignature: "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
      abiParameters: [
        total,
        String(input.domain),
        toBytes32(input.recipient),
        ARC_TESTNET_USDC,
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
export async function forwardedMint(burnTxHash: string, options: { fetch?: typeof fetch } = {}): Promise<{ mintTxHash: string } | null> {
  try {
    const response = await (options.fetch ?? fetch)(`${IRIS}/v2/messages/${ARC_TESTNET_DOMAIN}?transactionHash=${burnTxHash}`, {
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
