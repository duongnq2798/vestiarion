export type Domain = "ap" | "ar" | "contractor" | "treasury" | "compliance" | "system";
export type Outcome = "settled" | "scheduled" | "held" | "refused" | "simulated" | "recorded";
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
  limit: number;
  note?: string;
}

export interface Decision {
  id: string;
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
  auditSeq?: number;
  at: string;
}

export interface Account {
  id: string;
  name: string;
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
