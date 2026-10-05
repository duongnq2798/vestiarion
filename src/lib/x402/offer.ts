import { ARC_TESTNET_USDC } from "../circle/cctp";
import { GATEWAY_WALLET } from "../circle/gateway";
import { ARC_TESTNET } from "../network";

/**
 * Vestiarion's x402 offer for payee history (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md
 * §2, R2): what the seller asks for, and what the buyer accepts. Both sides read it from here, so the agent
 * never pays an offer the seller would not make.
 */

/** Arc testnet, as x402 names a network (CAIP-2). */
export const X402_NETWORK = ARC_TESTNET.caip2;

/** Circle Gateway's batched settlement: the buyer signs against GatewayWallet, not USDC (Gateway nanopayments). */
export const GATEWAY_BATCHING = { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET } as const;

/** Circle's x402 facilitator for testnets: verifies and settles Gateway-batched payments. */
export const GATEWAY_FACILITATOR_URL = ARC_TESTNET.gateway.facilitator;

export const PAYEE_HISTORY_PATH = "/api/x402/payee-history";

/** 0.001 USDC a call (R2), in USDC's 6-decimal units. */
export const PAYEE_HISTORY_PRICE_UNITS = "1000";
export const PAYEE_HISTORY_PRICE_USDC = 0.001;

/** Vestiarion's own workspace's operating wallet (`founding`): its Gateway balance holds what it earns (R2). */
export const VESTIARION_SELLER = "0x2fafddA3F973e8f993911F1c2196d5E72D51d71d";

/** How long the seller lets a signed authorization take to settle, as Circle's own sample asks. */
const MAX_TIMEOUT_SECONDS = 345_600;

export interface X402Requirements {
  scheme: "exact";
  network: typeof X402_NETWORK;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: string };
}

/** The one way payee history is paid for. */
export function payeeHistoryRequirements(): X402Requirements {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: PAYEE_HISTORY_PRICE_UNITS,
    payTo: VESTIARION_SELLER,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { ...GATEWAY_BATCHING },
  };
}

/** Whether an offer is exactly this one: the same network, token, contract, payee and price. Case does not matter in addresses. */
export function sameOffer(offer: unknown, expected: X402Requirements = payeeHistoryRequirements()): boolean {
  if (!offer || typeof offer !== "object") return false;
  const o = offer as Partial<X402Requirements> & { extra?: Partial<X402Requirements["extra"]> };
  const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : null);
  return (
    o.scheme === expected.scheme &&
    o.network === expected.network &&
    lower(o.asset) === lower(expected.asset) &&
    String(o.amount) === expected.amount &&
    lower(o.payTo) === lower(expected.payTo) &&
    o.extra?.name === expected.extra.name &&
    o.extra?.version === expected.extra.version &&
    lower(o.extra?.verifyingContract) === lower(expected.extra.verifyingContract)
  );
}

export const encodeHeader = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

export function decodeHeader<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** An Arc address: 0x and 40 hex characters. */
export const isArcAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
