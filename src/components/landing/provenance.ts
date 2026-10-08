import type { ProvenanceLeg } from "@/components/vx/Provenance";
import { ARC_TESTNET, type NetworkProfile } from "@/lib/network";
import { chainById, paidAcrossChains } from "@/lib/payee-chains";
import type { OpenNumbers } from "@/lib/platform/open-numbers";

/** The research note's section on the treasury with real USYC: its moves, by signed entry (landing proof P1). */
export const RESERVE_PROOF_HREF = "/docs/research/model-vs-policy#the-treasury-with-real-usyc";

export interface LandingProvenanceFacts {
  /** The founding workspace pays through Circle live. */
  paymentsLive: boolean;
  /** The founding workspace's own USYC reserve is real. */
  foundingReserveLive: boolean;
  /** Some live workspace runs a real USYC reserve: a count across workspaces, never which one. */
  reserveRunsLive: boolean;
  screeningLive: boolean;
  /** The team's latest payment on Arc mainnet, on its explorer; null when there is none or it could not be read. */
  mainnetTxUrl: string | null;
}

/**
 * What the hero says runs live (docs/superpowers/specs/2026-10-08-landing-proof-design.md P1, P2). Each leg says what
 * this deployment runs, as Screening always has: the reserve is live once any live workspace runs a real one, and a
 * live leg links to what shows it, the payments leg to the latest Arc mainnet payment on its explorer. A simulated leg
 * links nowhere.
 */
export function landingProvenance(facts: LandingProvenanceFacts): ProvenanceLeg[] {
  const reserveLive = facts.foundingReserveLive || facts.reserveRunsLive;
  return [
    {
      label: "Payments",
      detail: "Arc mainnet and testnet",
      live: facts.paymentsLive,
      href: facts.mainnetTxUrl ?? "/open#mainnet",
      hrefLabel: facts.mainnetTxUrl ? "See the latest payment on Arc mainnet" : "See the payments on Arc mainnet",
    },
    reserveLive
      ? { label: "Yield", detail: `USYC reserve, ${ARC_TESTNET.label}`, live: true, href: RESERVE_PROOF_HREF, hrefLabel: "Read what the reserve did" }
      : { label: "Yield", detail: "USYC reserve", live: false },
    { label: "Screening", detail: facts.screeningLive ? "OpenSanctions" : "bundled list", live: facts.screeningLive },
  ];
}

/**
 * The team's latest payment on a network, on its explorer, as /open links it: a Gateway payout's hash is its mint on the
 * payee's chain, everything else is on the network itself. Null when the team has paid nothing there, or nothing was read.
 */
export function latestOwnPaymentUrl(numbers: OpenNumbers | null, network: NetworkProfile): string | null {
  const latest = numbers?.ourPayments[0];
  if (!latest) return null;
  return paidAcrossChains(latest.chain) ? `${chainById(latest.chain as string).explorerTx}${latest.txHash}` : `${network.explorer}/tx/${latest.txHash}`;
}
