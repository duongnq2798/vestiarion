/**
 * The networks a workspace can pay on, one profile each (docs/superpowers/specs/2026-10-05-network-foundation-design.md
 * N1, N6). Every chain fact lives here: how copy names the network, Circle's name for its blockchain, its chain id,
 * RPC and explorer, its tokens, and which features run on it. Pure data, safe in client components.
 *
 * Arc testnet's values are the ones every module used before this file existed; those modules now read them from here.
 * Arc mainnet's come from docs.arc.io and developers.circle.com as read on 2026-10-04, and are checked again before
 * phase 2 uses them. A feature not verified there is null, and is off there: USYC (institutional only), Gateway, CCTP,
 * the Stablecoin Service's swap, and hosted wallets.
 */

export const NETWORK_IDS = ["arc-testnet", "arc-mainnet"] as const;
export type Network = (typeof NETWORK_IDS)[number];

export interface NetworkProfile {
  id: Network;
  /** How copy names it: "Arc testnet", "Arc mainnet". */
  label: string;
  /** Circle's blockchain name, for wallets and transactions. */
  circleBlockchain: string;
  chainId: number;
  /** As x402 names a network (CAIP-2). */
  caip2: string;
  rpcUrl: string;
  explorer: string;
  tokens: { USDC: string; EURC: string };
  /** CCTP's domain for this network and Iris, Circle's attestation API; null where CCTP payouts do not run. */
  cctp: { domain: number; iris: string } | null;
  /** Gateway's API and Circle's x402 facilitator; null where Gateway does not run. */
  gateway: { api: string; facilitator: string } | null;
  /** The real reserve's token, Teller and entitlements; null where USYC is not offered. */
  usyc: { token: string; teller: string; entitlements: string } | null;
  /** The Stablecoin Service's name for this chain; null where the swap does not run. */
  stablecoinServiceChain: string | null;
  /** Whether a workspace may choose a wallet hosted by Vestiarion. */
  hostedWallets: boolean;
  /** The prefix of a Circle API key for this network (N5). */
  circleKeyPrefix: string;
  /**
   * Circle Modular Wallets' path for this chain, for a payee's passkey wallet (payee passkey wallet P1); null where they
   * do not run.
   */
  modularWallets: { chain: string } | null;
}

export const ARC_TESTNET = {
  id: "arc-testnet",
  label: "Arc testnet",
  circleBlockchain: "ARC-TESTNET",
  chainId: 5042002,
  caip2: "eip155:5042002",
  rpcUrl: "https://rpc.testnet.arc.network",
  explorer: "https://explorer.testnet.arc.io",
  tokens: { USDC: "0x3600000000000000000000000000000000000000", EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" },
  cctp: { domain: 26, iris: "https://iris-api-sandbox.circle.com" },
  gateway: { api: "https://gateway-api-testnet.circle.com/v1", facilitator: "https://gateway-api-testnet.circle.com" },
  usyc: {
    token: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
    teller: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
    entitlements: "0xCC205224862C7641930c87679E98999d23C26113",
  },
  stablecoinServiceChain: "Arc_Testnet",
  hostedWallets: true,
  circleKeyPrefix: "TEST_API_KEY:",
  modularWallets: { chain: "arcTestnet" },
} as const satisfies NetworkProfile;

export const ARC_MAINNET = {
  id: "arc-mainnet",
  label: "Arc mainnet",
  circleBlockchain: "ARC",
  chainId: 5042,
  caip2: "eip155:5042",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorer: "https://explorer.arc.io",
  tokens: { USDC: "0x3600000000000000000000000000000000000000", EURC: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1" },
  cctp: null,
  gateway: null,
  usyc: null,
  stablecoinServiceChain: null,
  hostedWallets: false,
  circleKeyPrefix: "LIVE_API_KEY:",
  modularWallets: null,
} as const satisfies NetworkProfile;

export const NETWORKS: Record<Network, NetworkProfile> = { "arc-testnet": ARC_TESTNET, "arc-mainnet": ARC_MAINNET };

export function networkProfile(network: Network): NetworkProfile {
  return NETWORKS[network];
}

/**
 * A network id as a row or a request gives it: missing (a row from before 0075) is Arc testnet, the default for every
 * workspace; anything else unknown is refused rather than guessed, since a wrong network moves money wrongly.
 */
export function networkOf(value: string | null | undefined): Network {
  if (value === null || value === undefined) return "arc-testnet";
  if ((NETWORK_IDS as readonly string[]).includes(value)) return value as Network;
  throw new Error(`"${value}" is not a network Vestiarion knows`);
}
