/**
 * The agent's guardrail rules in words, for people: the landing's latest decision says why code refused one, and a
 * decision card's band names the rule this way, its id kept for a tooltip. The id itself (`invoice.match_incomplete`)
 * is for the ledger and the API, never the only thing a person reads.
 */

/** A guardrail rule in words that name no one: the payee is "the payee", whoever it is. */
export const RULE_WORDS: Record<string, string> = {
  "counterparty.payment_limit": "it is above the payee's payment limit",
  "counterparty.address_unconfirmed": "the payee's address changed and no one had confirmed it",
  "counterparty.no_address": "the payee had no payment address yet",
  "counterparty.unscreened": "the payee had not been screened yet",
  "counterparty.high_risk": "the payee was screened high risk",
  "counterparty.client_payable": "the payee is a client, who pays the business",
  "counterparty.new_payee": "a first payment to a new address needs two people",
  "invoice.duplicate_of_settled": "it repeats a bill already paid",
  "invoice.match_incomplete": "its purchase order or goods receipt was missing",
  "workspace.two_approvals": "it is above the figure where two people approve",
  "workspace.outflow_budget": "it would pass the workspace's spending limit",
  "workspace.onchain_limit": "it would pass the spending limit set on Arc",
  "workspace.onchain_limit_route": "the spending limit on Arc cannot pay it this way",
  "treasury.insufficient_eurc": "the wallet held too little EURC",
  "fx.rate_unavailable": "no exchange rate could be read",
  "fx.swap_cost_above_cap": "the currency swap cost more than its cap",
  "fx.swap_usdc_short": "too little USDC was left to swap",
  "bridge.fee_above_cap": "the cross-chain fee was above its cap",
  "bridge.fee_unavailable": "the cross-chain fee could not be read",
  "bridge.gateway_balance_short": "the Gateway balance was short",
  "bridge.unsupported_token": "that token cannot cross chains",
};

/** A rule in words, as a clause ("its purchase order or goods receipt was missing"), or null for one with none. */
export function ruleWords(rule: string | null | undefined): string | null {
  return (rule && RULE_WORDS[rule]) || null;
}

/** A rule as a decision card names it: its words as a sentence, or "A check in code" for a rule with none yet. */
export function ruleLabel(rule: string): string {
  const words = ruleWords(rule);
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "A check in code";
}
