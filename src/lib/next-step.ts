/**
 * What a person can do about a payable code stopped (agent activity spec R5): the rule, in words, and the page that
 * removes its cause. Approvals, where any of them can be paid or rejected, is offered beside it by the card. Pure.
 */

export interface NextStep {
  /** What stopped it and what can be done, in one or two sentences. */
  sentence: string;
  /** The page that removes the cause, for an owner or admin; null when only a decision in Approvals helps. */
  fix: { label: string; path: string } | null;
}

/** A counterparty's row on Counterparties, which a link opens at (`ScrollToHash` opens a closed row). */
export function counterpartyPath(counterpartyId: string): string {
  return `/counterparties#counterparty-${counterpartyId}`;
}

/** The next step for a guardrail rule, or null for a stop no rule explains (a model's own hold). */
export function ruleNextStep(rule: string | null | undefined, counterparty: { id: string; name: string }): NextStep | null {
  const row = counterpartyPath(counterparty.id);
  switch (rule) {
    case "counterparty.payment_limit":
      return { sentence: `It is above ${counterparty.name}'s payment limit. Pay it in Approvals, or raise the limit.`, fix: { label: "Edit limit", path: row } };
    case "counterparty.address_unconfirmed":
      return {
        sentence: `${counterparty.name}'s payment address changed and no one has confirmed it. Confirm it, or pay it in Approvals.`,
        fix: { label: "Confirm address", path: row },
      };
    case "counterparty.unscreened":
      return {
        sentence: `${counterparty.name} has not been screened yet. Screening runs again at every cycle, and the agent decides it again once there is a verdict; you can also pay it in Approvals.`,
        fix: { label: "Open counterparty", path: row },
      };
    case "counterparty.high_risk":
      return {
        sentence: `${counterparty.name} is screened high risk, so it is never paid. Review the screening match, or reject the invoice in Approvals.`,
        fix: { label: "Review screening", path: "/compliance" },
      };
    case "invoice.duplicate_of_settled":
      return { sentence: "It repeats an invoice already paid, being paid or scheduled. Reject it in Approvals if it is a duplicate.", fix: null };
    case "workspace.outflow_budget":
      return { sentence: "The agent's spending limit has no room for it. Raise the limit, or pay it in Approvals.", fix: { label: "Spending limit", path: "/console#agent-budget" } };
    case "workspace.onchain_limit":
      return {
        sentence: "The spending-limit contract on Arc would refuse it. Raise the limit, or pay it in Approvals.",
        fix: { label: "Spending limit", path: "/console#agent-budget" },
      };
    case "workspace.onchain_limit_route":
      return { sentence: "The spending-limit contract carries only USDC paid on Arc. Pay it in Approvals.", fix: null };
    case "bridge.fee_above_cap":
      return { sentence: "The payout fee is above 10% of the invoice, more than the agent pays. Pay it with the fee in Approvals, or reject it.", fix: null };
    case "bridge.fee_unavailable":
      return { sentence: "Circle gave no fee for this payout, so its cost is not known. Pay it in Approvals, or return it to the agent later.", fix: null };
    case "bridge.gateway_balance_short":
      return { sentence: "The Gateway balance does not cover this payout. Fund Gateway, or pay it in Approvals.", fix: { label: "Treasury", path: "/console" } };
    case "bridge.unsupported_token":
      return { sentence: "Only USDC crosses chains, and this invoice is in EURC. Reject it in Approvals, or ask for an invoice in USDC.", fix: null };
    case "fx.rate_unavailable":
      return { sentence: "No EURC rate was available. Return it to the agent later, or pay it in Approvals.", fix: null };
    case "fx.swap_cost_above_cap":
    case "fx.swap_usdc_short":
    case "treasury.insufficient_eurc":
      return { sentence: "The operating wallet is short of EURC for it. Add EURC to the wallet, or pay it in Approvals.", fix: { label: "Treasury", path: "/console" } };
    default:
      return null;
  }
}
