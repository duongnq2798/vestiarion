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

/**
 * The next step's key for a payable held because the cash it needs was not there (reserve cash back R4). No guardrail
 * refused it, but a person is told what it waits for, and what brings the cash, as for a rule.
 */
export const CASH_SHORTFALL = "treasury.cash_shortfall";

/**
 * Whether an AP decision held the payable for want of cash: its `execution.heldBecause`, as the AP stage records it
 * (`HELD_FOR_CASH` in ./agent/liquidity, which this module, read by the browser too, does not import).
 */
export function heldForCash(detail: Record<string, unknown> | null | undefined): boolean {
  if (!detail || detail.guardrailBlocked === true) return false;
  const execution = detail.execution;
  return typeof execution === "object" && execution !== null && (execution as Record<string, unknown>).heldBecause === "cash_shortfall";
}

/**
 * The guardrail rule for an incomplete three-way match (three-way match design M3). Unlike the other rules, what removes
 * its cause can be added where the payable waits: the details it lacks, with Add details.
 */
export const MATCH_INCOMPLETE = "invoice.match_incomplete";

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
    case "counterparty.client_payable":
      return {
        sentence: `${counterparty.name} is a client: it pays you. If this is a refund, pay it in Approvals; if it is money ${counterparty.name} owes you, reject it and add it as a receivable.`,
        fix: null,
      };
    case "counterparty.high_risk":
      // "Not this person" is on the counterparty's row: a dismissed match lowers its risk, and the agent decides again.
      return {
        sentence: `${counterparty.name} is screened high risk, so it is never paid. Review the screening match, or reject the invoice in Approvals.`,
        fix: { label: "Review screening", path: row },
      };
    case "invoice.duplicate_of_settled":
      return { sentence: "It repeats an invoice already paid, being paid or scheduled. Reject it in Approvals if it is a duplicate.", fix: null };
    case "counterparty.new_payee":
      // Two people before the first payment to an address (new payee check N3, N4): the second one decides in Approvals.
      return {
        sentence: `It is the first payment to ${counterparty.name}'s address, and only one person stands behind it. Someone other than whoever gave the address approves it in Approvals; after that, the agent pays this address on its own.`,
        fix: null,
      };
    case MATCH_INCOMPLETE:
      // The counterparty's row says whether it needs purchase orders, and an owner or admin changes it there (M2, M7).
      return {
        sentence: `Its three-way match is incomplete. Add the purchase order or confirm the goods with Add details, and the agent decides it again; or mark ${counterparty.name} as paid without purchase orders, if it is.`,
        fix: { label: "Purchase orders", path: row },
      };
    case "workspace.outflow_budget":
      return {
        sentence: "The agent's spending limit has no room for it. The agent pays it on its own once there is room, the next UTC day or once the limit is raised; or pay it in Approvals.",
        fix: { label: "Spending limit", path: "/console#agent-budget" },
      };
    case "workspace.onchain_limit":
      return {
        sentence: "The spending-limit contract on Arc would refuse it. Raise the limit, or pay it in Approvals.",
        fix: { label: "Spending limit", path: "/console#agent-budget" },
      };
    case CASH_SHORTFALL:
      return {
        sentence:
          "The operating wallet did not hold the cash it needs, and the reserve could not cover it. The agent decides it again on its own once cash comes in: add USDC to the operating wallet, or bring cash back from the USYC reserve; or pay it in Approvals.",
        fix: { label: "USYC reserve", path: "/settings#usyc-reserve-title" },
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

/**
 * What happens with no one approving, for a payable a rule stopped: the agent decides it again on its own once the
 * cause is gone (follow-up stage). Said on the Approvals card to a person who may not approve it (approval guidance).
 */
export function agentResumes(rule: string | null | undefined): string | null {
  switch (rule) {
    case "workspace.outflow_budget":
      return "The agent pays it on its own once its spending limit has room: the next UTC day, or sooner if an owner or admin raises the limit.";
    case "counterparty.payment_limit":
      return "The agent decides it again on its own once an owner or admin raises the counterparty's payment limit.";
    case "counterparty.unscreened":
      return "The agent decides it again on its own once screening gives a verdict.";
    case MATCH_INCOMPLETE:
      return "The agent decides it again on its own once an owner or admin adds what the match lacks, or marks the counterparty as paid without purchase orders.";
    case "counterparty.new_payee":
      return "The agent decides it again on its own once another payment to this address goes through.";
    case CASH_SHORTFALL:
      return "The agent decides it again on its own once cash comes in: USDC added to the operating wallet, or brought back from the reserve.";
    default:
      return null;
  }
}

/** Why code stopped a payment, in a few words, for a toast; the card says the rest (`ruleNextStep`). */
export function ruleInBrief(rule: string | null | undefined): string | null {
  switch (rule) {
    case "counterparty.payment_limit":
      return "it is above the counterparty's payment limit";
    case "counterparty.address_unconfirmed":
      return "the payment address changed and is not confirmed";
    case "counterparty.unscreened":
      return "the counterparty is not screened yet";
    case "counterparty.high_risk":
      return "the counterparty is screened high risk";
    case "counterparty.client_payable":
      return "the counterparty is a client, which pays you";
    case "invoice.duplicate_of_settled":
      return "it repeats an invoice already paid";
    case MATCH_INCOMPLETE:
      return "its three-way match is incomplete";
    case "counterparty.new_payee":
      return "it would be the first payment to an address only one person stands behind";
    case "workspace.outflow_budget":
      return "the agent's spending limit has no room today, and the agent pays it once there is";
    case "workspace.onchain_limit":
      return "the spending-limit contract on Arc would refuse it";
    case "workspace.onchain_limit_route":
      return "the spending-limit contract carries only USDC on Arc";
    case "bridge.fee_above_cap":
      return "the payout fee is above 10% of the invoice";
    case "bridge.fee_unavailable":
      return "Circle gave no fee for the payout";
    case "bridge.gateway_balance_short":
      return "the Gateway balance does not cover it";
    case "bridge.unsupported_token":
      return "only USDC crosses chains";
    case "fx.rate_unavailable":
      return "no EURC rate was available";
    case "fx.swap_cost_above_cap":
    case "fx.swap_usdc_short":
    case "treasury.insufficient_eurc":
      return "the wallet is short of EURC";
    default:
      return rule ? `rule ${rule}` : null;
  }
}
