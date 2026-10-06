/**
 * The networks a workspace can pay on, one profile each (docs/superpowers/specs/2026-10-05-network-foundation-design.md
 * N1, N6). Every chain fact lives here: how copy names the network, Circle's name for its blockchain, its chain id,
 * RPC and explorer, its tokens, the chains a payee can be paid on from it, its contracts, and which features run on
 * it. Pure data, safe in client components. Every module reads these facts from its workspace's profile, or its
 * record's (docs/superpowers/specs/2026-10-05-network-threading-design.md P1, P2).
 *
 * Arc testnet's values are the ones every module used before this file existed; those modules now read them from here.
 * Arc mainnet's come from docs.arc.io and developers.circle.com as read on 2026-10-04; the dry run with a live Circle
 * key checks them again before any mainnet workspace goes live. A feature not verified there is null, and is off there: USYC (institutional only), Gateway, CCTP,
 * the Stablecoin Service's swap, and hosted wallets. Its wallets are EOAs that pay their own gas, and the per-workspace
 * contracts (escrow, the spending limit) are off there too (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md
 * M6).
 */

export const NETWORK_IDS = ["arc-testnet", "arc-mainnet"] as const;
export type Network = (typeof NETWORK_IDS)[number];

/**
 * A chain a payee can be paid on from a network (network threading P3): the network's own chain, paid directly, or one
 * CCTP and Gateway pay to from it.
 */
export interface PayeeChainEntry {
  /** Circle's blockchain name: "ARC-TESTNET", "BASE-SEPOLIA", "ARC". */
  readonly id: string;
  readonly label: string;
  /** CCTP's domain for the chain; null where CCTP is not verified. */
  readonly domain: number | null;
  /** USDC's ERC-20 contract on the chain. */
  readonly usdc: string;
  readonly rpcUrl: string;
  /** A transaction on the chain's explorer, without its hash. */
  readonly explorerTx: string;
  /** Arc's native USDC (18 decimals) beside its ERC-20 interface, which a receipt reads too; absent elsewhere. */
  readonly nativeUsdc?: string;
}

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
  /**
   * The chains a payee can be paid on (P3): this network's own first, its home chain, then those CCTP and Gateway pay
   * to from it.
   */
  payeeChains: readonly [PayeeChainEntry, ...PayeeChainEntry[]];
  /**
   * CCTP's domain for this network, Iris (Circle's attestation API) and the TokenMessenger a burn goes through; null
   * where CCTP payouts do not run.
   */
  cctp: { domain: number; iris: string; tokenMessenger: string } | null;
  /** Gateway's API, Circle's x402 facilitator, and Gateway's wallet and minter contracts; null where Gateway does not run. */
  gateway: { api: string; facilitator: string; wallet: string; minter: string } | null;
  /** The real reserve's token, Teller and entitlements; null where USYC is not offered. */
  usyc: { token: string; teller: string; entitlements: string } | null;
  /** The Stablecoin Service's name for this chain; null where the swap does not run. */
  stablecoinServiceChain: string | null;
  /**
   * The swap's Adapter, the spender a USDC→EURC swap approves: Circle's App Kit's `kitContracts.adapter` for the chain;
   * null where the swap does not run.
   */
  swapAdapter: string | null;
  /** Whether a workspace may choose a wallet hosted by Vestiarion. */
  hostedWallets: boolean;
  /** The prefix of a Circle API key for this network (N5). */
  circleKeyPrefix: string;
  /**
   * Circle Modular Wallets' path for this chain, for a payee's passkey wallet (payee passkey wallet P1); null where they
   * do not run.
   */
  modularWallets: { chain: string } | null;
  /**
   * The account type of the workspace's treasury wallets (mainnet go-live M6): a smart account whose gas Circle Gas
   * Station pays, or an EOA that pays its own gas in USDC. Circle bills Gas Station on mainnet and refuses an SCA there
   * until a paymaster policy exists, so Arc mainnet's are EOAs.
   */
  walletAccountType: "SCA" | "EOA";
  /** USDC the operating wallet keeps aside for its own gas (M6): 0 where gas is sponsored. */
  gasReserveUsdc: number;
  /** Whether a milestone's USDC can be locked in the per-workspace escrow contract (M6). */
  escrow: boolean;
  /** Whether the agent's spending limit can be enforced by its per-workspace contract (M6). */
  spendingLimitContract: boolean;
  /** Whether the chain's native currency is USDC (M7): Arc's is, so Circle's native entry for a wallet is USDC. */
  usdcIsNative: boolean;
  /**
   * Whether a workspace on this network may go live (final review I3). A network opens once what a workspace there
   * needs is in, by construction rather than by procedure: Arc mainnet opened with its approval limits (phase 2b) and
   * the copy that names it (phase 2c, mainnet copy C13). Its other gates stay: the deployment's switch, the allowlist,
   * the typed word, and the workspace's own Circle account with a live key.
   */
  goLiveOpen: boolean;
  /**
   * Whether a workspace may pay from a wallet its owner holds, through its spending limit contract (wallet treasury W2):
   * Arc mainnet for now. Arc testnet's reserve, escrow, Gateway and swap would each need to tell such a treasury apart.
   */
  walletTreasury: boolean;
  /**
   * Where people get this network's test tokens: Circle's faucet on Arc testnet, none on Arc mainnet, where USDC is real
   * (phase 2c C2). Copy that would send someone to a faucet reads this, so a mainnet workspace is never sent to one.
   */
  faucet: string | null;
  /**
   * How long a transfer may go unconfirmed after it was sent before the workspace's people are told (stuck-transfer
   * alert D1): Arc confirms in seconds and Circle within a minute, so 15 minutes is far past normal on both networks,
   * and matches the 15 minutes the cycle waits before it sends again one Circle never answered.
   */
  stuckAfterMinutes: number;
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
  payeeChains: [
    {
      id: "ARC-TESTNET",
      label: "Arc testnet",
      domain: 26,
      usdc: "0x3600000000000000000000000000000000000000",
      rpcUrl: "https://rpc.testnet.arc.network",
      explorerTx: "https://explorer.testnet.arc.io/tx/",
      nativeUsdc: "0xfffffffffffffffffffffffffffffffffffffffe",
    },
    {
      id: "BASE-SEPOLIA",
      label: "Base Sepolia",
      domain: 6,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      rpcUrl: "https://sepolia.base.org",
      explorerTx: "https://sepolia.basescan.org/tx/",
    },
    {
      id: "ARB-SEPOLIA",
      label: "Arbitrum Sepolia",
      domain: 3,
      usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
      explorerTx: "https://sepolia.arbiscan.io/tx/",
    },
    {
      id: "ETH-SEPOLIA",
      label: "Ethereum Sepolia",
      domain: 0,
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      explorerTx: "https://sepolia.etherscan.io/tx/",
    },
  ],
  // The TokenMessenger, and Gateway's wallet and minter, are the same contracts on every testnet CCTP and Gateway serve.
  cctp: { domain: 26, iris: "https://iris-api-sandbox.circle.com", tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
  gateway: {
    api: "https://gateway-api-testnet.circle.com/v1",
    facilitator: "https://gateway-api-testnet.circle.com",
    wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  },
  usyc: {
    token: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
    teller: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
    entitlements: "0xCC205224862C7641930c87679E98999d23C26113",
  },
  stablecoinServiceChain: "Arc_Testnet",
  swapAdapter: "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b",
  hostedWallets: true,
  circleKeyPrefix: "TEST_API_KEY:",
  modularWallets: { chain: "arcTestnet" },
  walletAccountType: "SCA",
  gasReserveUsdc: 0,
  escrow: true,
  spendingLimitContract: true,
  usdcIsNative: true,
  goLiveOpen: true,
  walletTreasury: false,
  faucet: "https://faucet.circle.com",
  stuckAfterMinutes: 15,
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
  payeeChains: [
    {
      id: "ARC",
      label: "Arc mainnet",
      domain: null,
      usdc: "0x3600000000000000000000000000000000000000",
      rpcUrl: "https://rpc.mainnet.arc.io",
      explorerTx: "https://explorer.arc.io/tx/",
      // Arc's native USDC system emitter (EIP-7708), which mainnet has used since genesis (docs.arc.io, USDC system
      // events): a receipt reads a native transfer from it, as on Arc testnet (mainnet limits L5).
      nativeUsdc: "0xfffffffffffffffffffffffffffffffffffffffe",
    },
  ],
  cctp: null,
  gateway: null,
  usyc: null,
  stablecoinServiceChain: null,
  swapAdapter: null,
  hostedWallets: false,
  circleKeyPrefix: "LIVE_API_KEY:",
  modularWallets: null,
  walletAccountType: "EOA",
  gasReserveUsdc: 0.1,
  escrow: false,
  spendingLimitContract: false,
  usdcIsNative: true,
  goLiveOpen: true,
  walletTreasury: true,
  faucet: null,
  stuckAfterMinutes: 15,
} as const satisfies NetworkProfile;

export const NETWORKS: Record<Network, NetworkProfile> = { "arc-testnet": ARC_TESTNET, "arc-mainnet": ARC_MAINNET };

/** Every chain id a payee can be paid on, across the networks. */
export type PayeeChainId = (typeof ARC_TESTNET.payeeChains)[number]["id"] | (typeof ARC_MAINNET.payeeChains)[number]["id"];

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

/**
 * A feature its network does not offer (network threading P5): it refuses by name, never falling back to another
 * network's values.
 */
export class FeatureOffError extends Error {
  constructor(feature: string, network: NetworkProfile) {
    super(`${feature} does not run on ${network.label} yet`);
    this.name = "FeatureOffError";
  }
}
