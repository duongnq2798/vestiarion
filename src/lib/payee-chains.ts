import { ARC_TESTNET, NETWORK_IDS, networkProfile, type Network, type PayeeChainEntry } from "./network";

/**
 * The chains a payee can be paid on, read from each network's profile (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md
 * X1; docs/superpowers/specs/2026-10-05-network-threading-design.md P3): a workspace pays its network's own chain
 * directly, and the chains CCTP and Gateway reach from it across chains. Every link to a transaction or an address is
 * built here, for the network it is on (P6). Pure data, safe in client components.
 */

/**
 * Arc testnet's payee chains, the public API's `chain` enum until Arc mainnet joins it in phase 2 (network threading P7,
 * §3): a mainnet workspace leaves `chain` out and is paid on its own chain.
 */
export const TESTNET_PAYEE_CHAIN_IDS = ARC_TESTNET.payeeChains.map((chain) => chain.id) as [
  (typeof ARC_TESTNET.payeeChains)[number]["id"],
  ...(typeof ARC_TESTNET.payeeChains)[number]["id"][],
];

/** The most a CCTP fee may be, as a percent of the invoice, before a payout waits for a person (CCTP payouts R4). */
export const BRIDGE_FEE_CAP_PERCENT = 10;

const EVERY_CHAIN = NETWORK_IDS.flatMap((network) => networkProfile(network).payeeChains.map((chain) => ({ network, chain })));
const OWN_CHAINS = new Set(NETWORK_IDS.map((network) => networkProfile(network).payeeChains[0].id));

/** Every chain a payee can be paid on, across the networks: which of them a workspace pays on is checked in its scope. */
export const ALL_PAYEE_CHAIN_IDS = EVERY_CHAIN.map((entry) => entry.chain.id) as [string, ...string[]];

/** A chain a workspace's network does not pay on (P3). */
export class ChainNotOnNetworkError extends Error {
  constructor(chain: string) {
    super(`${chain} is not a chain this workspace pays on`);
    this.name = "ChainNotOnNetworkError";
  }
}

/** The chains a workspace on `network` can pay a payee on: its own first, then those CCTP and Gateway reach. */
export function chainsOn(network: Network): readonly PayeeChainEntry[] {
  return networkProfile(network).payeeChains;
}

/** The chain a workspace on `network` pays directly: the network's own. */
export function homeChain(network: Network): PayeeChainEntry {
  return networkProfile(network).payeeChains[0];
}

/**
 * A payee's chain on the workspace's network: none (a row from before 0044) is the network's own chain; a chain the
 * network does not pay on, another network's or one no network lists, is refused rather than read as Arc testnet.
 */
export function chainOn(network: Network, value: string | null | undefined): PayeeChainEntry {
  if (value === null || value === undefined) return homeChain(network);
  const chain = chainsOn(network).find((entry) => entry.id === value);
  if (!chain) throw new ChainNotOnNetworkError(value);
  return chain;
}

/** The network a chain is on: each chain is on one network's list (P1). */
export function networkOfChain(chain: string): Network {
  const found = EVERY_CHAIN.find((entry) => entry.chain.id === chain);
  if (!found) throw new Error(`"${chain}" is not a chain Vestiarion knows`);
  return found.network;
}

/** A chain's entry by its id alone, for a record that names its chain. */
export function chainById(chain: string): PayeeChainEntry {
  return chainOn(networkOfChain(chain), chain);
}

/**
 * Whether a payee on this chain is paid across chains, through CCTP or Gateway, rather than on its network's own chain.
 * No chain is a row from before 0044, paid on its network's own chain; a chain no network lists is refused.
 */
export function paidAcrossChains(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  networkOfChain(value);
  return !OWN_CHAINS.has(value);
}

/** A transaction on a network's explorer. */
export function txUrl(network: Network, hash: string): string {
  return `${networkProfile(network).explorer}/tx/${hash}`;
}

/** A wallet or a contract on a network's explorer. */
export function addressUrl(network: Network, address: string): string {
  return `${networkProfile(network).explorer}/address/${address}`;
}
