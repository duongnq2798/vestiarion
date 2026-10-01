/**
 * The chains a payee can be paid on (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md
 * X1): Arc testnet directly, and three testnets that CCTP V2 pays to from Arc. Pure data, safe in
 * client components. `domain` is CCTP's identifier for the chain; Arc testnet is domain 26.
 */
export const PAYEE_CHAINS = [
  { id: "ARC-TESTNET", label: "Arc testnet", domain: 26, explorerTx: "https://testnet.arcscan.app/tx/" },
  { id: "BASE-SEPOLIA", label: "Base Sepolia", domain: 6, explorerTx: "https://sepolia.basescan.org/tx/" },
  { id: "ARB-SEPOLIA", label: "Arbitrum Sepolia", domain: 3, explorerTx: "https://sepolia.arbiscan.io/tx/" },
  { id: "ETH-SEPOLIA", label: "Ethereum Sepolia", domain: 0, explorerTx: "https://sepolia.etherscan.io/tx/" },
] as const;

export type PayeeChain = (typeof PAYEE_CHAINS)[number]["id"];

export const PAYEE_CHAIN_IDS = PAYEE_CHAINS.map((chain) => chain.id) as [PayeeChain, ...PayeeChain[]];

/** The most a CCTP fee may be, as a percent of the invoice, before a payout waits for a person (CCTP payouts R4). */
export const BRIDGE_FEE_CAP_PERCENT = 10;

/** The chain's entry, or Arc testnet's for a value that is not one of them (a row from before 0044). */
export function payeeChain(value: string | null | undefined) {
  return PAYEE_CHAINS.find((chain) => chain.id === value) ?? PAYEE_CHAINS[0];
}

/** Whether a payee on this chain is paid across chains, through CCTP, rather than on Arc. */
export function paidAcrossChains(value: string | null | undefined): boolean {
  return payeeChain(value).id !== "ARC-TESTNET";
}
