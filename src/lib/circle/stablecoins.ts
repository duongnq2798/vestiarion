import type { NetworkProfile } from "../network";
import type { Stablecoin } from "./types";

/**
 * Which stablecoin a token in a Circle wallet is (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M7):
 * chosen by its contract, never by its symbol. Circle lists two "USDC" entries for every Arc wallet, the native token
 * and the ERC-20 at 0x3600…, and anyone can deploy a token named "USDC".
 */

/** A token as Circle's wallet balance list names it. */
export interface CircleToken {
  id?: string;
  symbol?: string;
  tokenAddress?: string | null;
  isNative?: boolean;
}

const sameAddress = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Which stablecoin a token is on the network, or null: USDC is the native token where the chain's native currency is
 * USDC (Arc's is), or the ERC-20 at the profile's USDC address; EURC is the ERC-20 at the profile's EURC address.
 */
export function stablecoinOf(token: CircleToken | undefined, network: NetworkProfile): Stablecoin | null {
  if (!token) return null;
  if ((network.usdcIsNative && token.isNative === true) || sameAddress(token.tokenAddress, network.tokens.USDC)) return "USDC";
  if (sameAddress(token.tokenAddress, network.tokens.EURC)) return "EURC";
  return null;
}

/** The first of the wallet's entries that is `coin` on the network, in Circle's order. */
export function stablecoinEntry<T extends { token?: CircleToken }>(
  balances: readonly T[] | undefined,
  coin: Stablecoin,
  network: NetworkProfile
): T | undefined {
  return balances?.find((entry) => stablecoinOf(entry.token, network) === coin);
}
