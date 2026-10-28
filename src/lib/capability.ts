import { networkProfile, type Network } from "./network";

/**
 * What a workspace's payments do right now, in one place (docs/superpowers/specs/2026-10-14-capability-and-reasons-
 * design.md R1-R8). Every surface that tells a person whether a payment is real reads it from here: the header's chips
 * and status panel, Settings, the console, Approvals, the contractor and payee pages, the payee's email and the shared
 * report. Five situations, and only five:
 *
 * - `live-mainnet`: approved payments move real USDC on Arc mainnet.
 * - `live-testnet`: approved payments are sent in test USDC on Arc testnet.
 * - `simulated`: a sandbox paying through no wallet: payments are recorded and nothing is sent on chain.
 * - `shadow`: nothing is paid until a person agrees with the agent; what an agreement then pays is `afterVerdict`.
 *   While the owner lets the agent pay earned vendors on their own (`earnedPayments`), those are the exception
 *   (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL28).
 * - `unavailable`: nothing can be paid now: payments switched off, a fact the payment gates need could not be read, or
 *   the workspace held (Arc mainnet off or not live, no Circle account, credentials that cannot be read).
 *
 * The order of the checks is the payment gates' own (`assertPaymentsEnabled`, `paymentsHeld`, the agent's shadow read):
 * the platform's switch first, then the hold, then shadow mode, then the chain mode. A fact that could not be read is
 * never said as its healthy value. Pure and free of server modules, so client components read the same words;
 * `src/lib/capability-read.ts` gathers the facts inside a workspace's scope.
 */

export type Situation = "live-mainnet" | "live-testnet" | "simulated" | "shadow" | "unavailable";

export const SITUATIONS: readonly Situation[] = ["live-mainnet", "live-testnet", "simulated", "shadow", "unavailable"];

/** Why nothing can be paid: switched off, a switch or shadow mode that could not be read, or held. */
export type UnavailableCause = "off" | "unread" | "shadow-unread" | "held";

/**
 * How a state is drawn, everywhere it is drawn. `quiet` is a fact that needs no attention; `good` a working state, shown
 * by a jade dot only; `mainnet` is real money; `shadow` is the agent waiting for people; `simulated` is drawn dashed;
 * `held` and `stopped` ask for attention; `unknown` is not known on this screen.
 */
export type StatusTone = "quiet" | "good" | "mainnet" | "shadow" | "simulated" | "held" | "stopped" | "unknown";

export interface CapabilityFacts {
  network: Network;
  /** The platform's payments switch: on, off (with the reason it records, if any), or not read. */
  payments: { state: "on" } | { state: "off"; reason: string | null } | { state: "unread" };
  /** Why the workspace cannot pay now (its network's hold, or no provider), or null. */
  hold: string | null;
  /** The workspace's chain mode: live through a wallet, or simulated. */
  chainMode: "live" | "simulate";
  /** Whether shadow mode is on; null when it could not be read. */
  shadow: boolean | null;
  /** In shadow mode, whether the owner lets the agent pay earned vendors on their own (earned vendors AL21); absent is off. */
  earnedPayments?: boolean;
}

export interface Capability {
  situation: Situation;
  network: Network;
  /** In shadow mode, what a payment a person agrees to does; null otherwise. */
  afterVerdict: "live" | "simulated" | null;
  /** When unavailable, why, as a cause and in a sentence; null otherwise. */
  cause: UnavailableCause | null;
  why: string | null;
  /** In shadow mode, the agent pays earned vendors on its own (earned vendors AL22): only ever true. */
  earnedPayments?: true;
}

/** The words for a workspace with no wallet a payment can be made from (a hold with no reason of its own). */
export const NO_WALLET = "Nothing can be paid from this workspace right now: its wallet cannot be reached.";

const UNREAD = "Whether payments are switched on could not be read, and every payment is refused until it can be.";
const SHADOW_UNREAD = "Whether shadow mode is on could not be read, and the agent pays nothing until it can.";

function offSentence(reason: string | null): string {
  const why = reason?.trim().replace(/[.!?]+$/, "");
  return `Payments are switched off for every workspace${why ? `: ${why}` : ""}. Nothing is paid, moved or locked until they are back on.`;
}

const unavailable = (network: Network, cause: UnavailableCause, why: string): Capability => ({ situation: "unavailable", network, afterVerdict: null, cause, why });

/** The one situation the facts add up to. */
export function capabilityOf(facts: CapabilityFacts): Capability {
  const { network } = facts;
  if (facts.payments.state === "off") return unavailable(network, "off", offSentence(facts.payments.reason));
  if (facts.payments.state === "unread") return unavailable(network, "unread", UNREAD);
  if (facts.hold) return unavailable(network, "held", facts.hold);
  // The agent pays nothing on a guess: a shadow mode it cannot read stops its payments too.
  if (facts.shadow === null) return unavailable(network, "shadow-unread", SHADOW_UNREAD);
  const live = facts.chainMode === "live";
  if (facts.shadow) {
    return { situation: "shadow", network, afterVerdict: live ? "live" : "simulated", cause: null, why: null, ...(facts.earnedPayments ? { earnedPayments: true as const } : {}) };
  }
  if (!live) return { situation: "simulated", network, afterVerdict: null, cause: null, why: null };
  return { situation: network === "arc-mainnet" ? "live-mainnet" : "live-testnet", network, afterVerdict: null, cause: null, why: null };
}

/** Whether a payment made now is simulated: a sandbox's, or one agreed to in a simulated shadow mode. */
export function paysSimulated(capability: Capability): boolean {
  return capability.situation === "simulated" || (capability.situation === "shadow" && capability.afterVerdict === "simulated");
}

/** Whether a payment made now moves USDC on chain: live, or agreed to in a live shadow mode. */
export function paysOnChain(capability: Capability): boolean {
  return capability.situation === "live-mainnet" || capability.situation === "live-testnet" || (capability.situation === "shadow" && capability.afterVerdict === "live");
}

/**
 * Which USDC a network's payments move, as copy names it: real on Arc mainnet, test on Arc testnet. Every line that says
 * a payment is live or sent names it, so a live testnet workspace never reads as one moving real money.
 */
export function usdcWords(network: Capability["network"]): "real USDC" | "test USDC" {
  return network === "arc-mainnet" ? "real USDC" : "test USDC";
}

const UNAVAILABLE_LOOK: Record<UnavailableCause, { chip: string; value: string; tone: StatusTone }> = {
  off: { chip: "Payments off", value: "Off", tone: "stopped" },
  unread: { chip: "Payments", value: "Could not be read", tone: "unknown" },
  "shadow-unread": { chip: "Payments", value: "Not known", tone: "unknown" },
  held: { chip: "Payments held", value: "Held", tone: "held" },
};

/**
 * How a situation looks wherever it is drawn: the chip's label, the short value a row or badge shows, and its tone.
 * Live on Arc mainnet is real money in the brand colour; live on Arc testnet a working state; simulated dashed; shadow
 * mode the agent waiting for people; unavailable asks for attention, or is unknown when a fact could not be read.
 */
export function situationLook(capability: Capability): { chip: string; value: string; tone: StatusTone } {
  switch (capability.situation) {
    case "live-mainnet":
      return { chip: "Real payments live", value: "Live, real USDC", tone: "mainnet" };
    case "live-testnet":
      return { chip: "Test payments live", value: "Live, test USDC", tone: "good" };
    case "simulated":
      return { chip: "Payments simulated", value: "Simulated", tone: "simulated" };
    case "shadow":
      return { chip: "Shadow mode", value: capability.afterVerdict === "live" ? "Live, after your verdict" : "Simulated, after your verdict", tone: "shadow" };
    case "unavailable":
      return UNAVAILABLE_LOOK[capability.cause ?? "held"];
  }
}

/** What a payment does now, in a sentence: the header panel's Payments row, and every page that explains it. */
export function paymentSentence(capability: Capability): string {
  const network = networkProfile(capability.network).label;
  switch (capability.situation) {
    case "live-mainnet":
      return `Approved payments move real USDC on ${network}.`;
    case "live-testnet":
      return `Approved payments are sent in test USDC on ${network}.`;
    case "simulated":
      return "Payments are recorded here and nothing is sent on chain.";
    case "shadow":
      return capability.earnedPayments
        ? `Nothing is paid until a person agrees with the agent, except vendors that earned it under the owner's rule, which the agent pays on its own. ${agreedPaymentLine(capability)}`
        : `Nothing is paid until a person agrees with the agent. ${agreedPaymentLine(capability)}`;
    case "unavailable":
      return capability.why ?? NO_WALLET;
  }
}

/** What a payment a person agrees to does, in shadow mode's panels and on its cards. */
export function agreedPaymentLine(capability: Capability): string {
  if (capability.situation === "unavailable") return `Nothing is paid when you agree right now. ${capability.why ?? NO_WALLET}`;
  if (paysSimulated(capability)) return "A payment you agree to is simulated: nothing is sent on chain.";
  return `A payment you agree to is sent in ${usdcWords(capability.network)} on ${networkProfile(capability.network).label}.`;
}

/** What Agree and pay says before it pays, for a payment held for a verdict; null when it cannot pay now. */
export function agreeAndPayLine(capability: Capability): string | null {
  if (capability.situation === "unavailable") return null;
  if (paysSimulated(capability)) return "You agree with the agent, and it is paid now, simulated: nothing is sent on chain.";
  return `You agree with the agent, and it is paid in ${usdcWords(capability.network)} on ${networkProfile(capability.network).label} now.`;
}

/** The mark a confirmation adds to a payment it describes: " (simulated)" when it will be, else nothing. */
export function simulatedMark(capability: Capability): string {
  return paysSimulated(capability) ? " (simulated)" : "";
}

/**
 * The status API's `provenance.payments` (GET /api/v1/status): `unavailable` while nothing can pay (payments switched
 * off, the switch not read, the workspace held), otherwise the chain mode. Shadow mode is not a reason: a payment a
 * person agrees to is paid as the chain mode says.
 */
export function apiPayments(capability: Capability, chainMode: "live" | "simulate"): "live" | "simulate" | "unavailable" {
  if (capability.situation === "unavailable" && capability.cause !== "shadow-unread") return "unavailable";
  return chainMode;
}

/** What a payee reads, on their page and in their email, when their payment is simulated (a sandbox's). */
export const SIMULATED_PAYMENT = "This payment is simulated: no USDC is sent.";

/**
 * The situation in a few words after a workspace's standing, for a badge such as Go live's: "Live · paying on Arc
 * testnet", "Live · payments held".
 */
export function situationPhrase(capability: Capability): string {
  const network = networkProfile(capability.network).label;
  switch (capability.situation) {
    case "live-mainnet":
    case "live-testnet":
      return `paying on ${network}`;
    case "simulated":
      return "simulated payments";
    case "shadow":
      return capability.afterVerdict === "live" ? "shadow mode, paying after a verdict" : "shadow mode, simulated after a verdict";
    case "unavailable":
      return capability.cause === "off" ? "payments off" : capability.cause === "held" ? "payments held" : "payments not known";
  }
}

/** A badge's tone for the situation, in the badge's own palette (src/components/ui/Badge.tsx). */
export function situationBadgeTone(capability: Capability): "agent" | "proof" | "held" | "refused" | "simulated" | "neutral" {
  switch (situationLook(capability).tone) {
    case "mainnet":
    case "shadow":
      return "agent";
    case "good":
      return "proof";
    case "simulated":
      return "simulated";
    case "held":
      return "held";
    case "stopped":
      return "refused";
    default:
      return "neutral";
  }
}
