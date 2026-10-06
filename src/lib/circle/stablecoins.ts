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
 * Which stablecoin a token in a wallet on `chain` is, or null. On the network's own chain (the default), USDC is the
 * native token where its native currency is USDC (Arc's is), or the ERC-20 at the profile's USDC address, and EURC is
 * the ERC-20 at the profile's EURC address. On another of the network's payee chains (a wallet on Base Sepolia, say),
 * USDC is only the ERC-20 at that chain's own USDC address: its native token is that chain's gas, never USDC, and EURC
 * is not read there (final review I1). On a chain the network does not pay on, nothing is a stablecoin.
 */
export function stablecoinOf(token: CircleToken | undefined, network: NetworkProfile, chain: string = network.circleBlockchain): Stablecoin | null {
  if (!token) return null;
  if (chain === network.circleBlockchain) {
    if ((network.usdcIsNative && token.isNative === true) || sameAddress(token.tokenAddress, network.tokens.USDC)) return "USDC";
    if (sameAddress(token.tokenAddress, network.tokens.EURC)) return "EURC";
    return null;
  }
  const other = network.payeeChains.find((entry) => entry.id === chain);
  return other && sameAddress(token.tokenAddress, other.usdc) ? "USDC" : null;
}

/**
 * The wallet's entry that is `coin` on the network, for a wallet on `chain`. Circle lists Arc's USDC twice, as the
 * native token and as the ERC-20, with one balance: the ERC-20 is the one sent, whichever Circle lists first (mainnet
 * pre-flight). Its transfer() never calls the recipient, so a payee that is a contract, such as a Safe or an exchange's
 * deposit address, is paid, where native value sent to a contract is not guaranteed to arrive. The native entry when it
 * is the only one.
 */
export function stablecoinEntry<T extends { token?: CircleToken }>(
  balances: readonly T[] | undefined,
  coin: Stablecoin,
  network: NetworkProfile,
  chain?: string
): T | undefined {
  const entries = balances?.filter((entry) => stablecoinOf(entry.token, network, chain) === coin) ?? [];
  return entries.find((entry) => entry.token?.isNative !== true) ?? entries[0];
}
