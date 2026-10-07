export type Domain = "ap" | "ar" | "contractor" | "treasury" | "compliance" | "system";
import type { TrailStep } from "@/lib/decision-trail";
import type { Network } from "@/lib/network";

/** `deciding`: a payable not yet decided while a cycle runs, which is deciding it (decision trail R1). */
export type Outcome = "settled" | "scheduled" | "held" | "refused" | "simulated" | "recorded" | "deciding";
export type RiskTier = "unscreened" | "clear" | "medium" | "high";

export interface Evidence {
  label: string;
  value: string;
  href?: string;
  state?: "ok" | "missing" | "neutral";
}

export interface Guardrail {
  rule: string;
  attempted: number;
  /** What the rule allows, for a rule that is a limit; absent for one that refuses for another reason, which `reason` gives. */
  limit?: number;
  /** Why a rule that is not a limit refused it: a first payment to a new payee, an unconfirmed address. */
  reason?: string;
  note?: string;
  /** What `attempted` and `limit` are in, when not the decision's own token: a EURC invoice is weighed against a USDC limit. */
  attemptedToken?: string;
  limitToken?: string;
}

export interface Decision {
  id: string;
  /** The workspace's network (network threading P6): the card and its trail link transactions on its explorer. */
  network: Network;
  domain: Domain;
  action: string;
  subject: string;
  memo?: string;
  amount?: number;
  token?: string;
  outcome: Outcome;
  outcomeLabel?: string;
  reasoning: string;
  evidence: Evidence[];
  guardrail?: Guardrail | null;
  decisionMode?: string;
  txHash?: string | null;
  /** A payment to a payee on another chain: its mint there, which Circle's Forwarding Service submitted (CCTP payouts X11). */
  mint?: { chainLabel: string; txHash: string; href: string } | null;
  auditSeq?: number;
  at: string;
  /** How the agent decided it, step by step, from the signed entries about it (decision trail R2). */
  trail?: TrailStep[];
  /** A payable held because the cash it needs was not there, no guardrail refusing it (reserve cash back R4). */
  heldForCash?: boolean;
  /** A payment held in shadow mode for a person to agree, no rule refusing it (shadow mode S2). */
  heldForVerdict?: boolean;
}

export interface Account {
  id: string;
  name: string;
  /** Which account this is; the balance tile needs it to tell a reserve held on chain from the rest. */
  kind?: "operating" | "reserve" | "chain";
  chain: string;
  token: string;
  balance: number;
  apy: number | null;
  simulated: boolean;
}

export interface Forecast {
  horizonDays: number;
  inflow: number;
  outflow: number;
  liquid: number;
  recommendation: string;
}
