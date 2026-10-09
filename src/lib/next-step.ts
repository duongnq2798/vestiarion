import { HELD_FOR_VERDICT } from "./agent/shadow-hold";

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
 * The next step's key for a payment held in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S2): no
 * rule refused it, the agent decided to pay it, and it waits for a person to agree.
 */
export const SHADOW_VERDICT = "workspace.shadow_verdict";

/** Whether an AP decision held the payable in shadow mode: its `execution.heldBecause` (`HELD_FOR_VERDICT`). */
export function heldForVerdict(detail: Record<string, unknown> | null | undefined): boolean {
  if (!detail || detail.guardrailBlocked === true) return false;
  const execution = detail.execution;
  return typeof execution === "object" && execution !== null && (execution as Record<string, unknown>).heldBecause === HELD_FOR_VERDICT;
}

/**
 * Whether a person settles this AP decision through a verdict (shadow mode S4): shadow mode held the agent's payment,
 * or the agent decided to pay in shadow mode (`shadow` on its entry) and a check in code held it, such as a first
 * payment to an address only one person stands behind. Either way the agent decided to pay, and a person agrees or
 * disagrees before anything moves, so every payment made in shadow mode carries a verdict.
 */
export function awaitsVerdict(detail: Record<string, unknown> | null | undefined): boolean {
  if (heldForVerdict(detail)) return true;
  if (!detail || detail.shadow !== true || detail.guardrailBlocked !== true) return false;
  const decision = detail.decision as Record<string, unknown> | null | undefined;
  const execution = detail.execution as Record<string, unknown> | null | undefined;
  return decision?.action === "pay" && execution?.resultingStatus === "held";
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
    case "counterparty.no_address":
      // Nothing can be sent until there is an address (counterparty.no_address); the follow-up decides it again once confirmed.
      return {
        sentence: `${counterparty.name} has no payment address yet. Add it, or ask ${counterparty.name} for it with a one-time link; the agent decides it again once the address is confirmed.`,
        fix: { label: "Add address", path: row },
      };
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
    case "workspace.two_approvals":
      // Two people's approval above the workspace's figure (two approvals T3, T4): the first is recorded, the second pays.
      return {
        sentence:
          "Payments above the workspace's figure need two people's approval. Two people who can approve payments approve it in Approvals: the first approval is recorded, and the second pays it.",
        fix: null,
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
    case SHADOW_VERDICT:
      return {
        sentence: "Shadow mode: the agent decided to pay it, and pays nothing until a person agrees. Agree and pay it, or disagree, in Approvals.",
        fix: null,
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
    case "counterparty.no_address":
      return "The agent decides it again on its own once the counterparty has an address and a person has confirmed it.";
    case MATCH_INCOMPLETE:
      return "The agent decides it again on its own once an owner or admin adds what the match lacks, or marks the counterparty as paid without purchase orders.";
    case "counterparty.new_payee":
      return "The agent decides it again on its own once another payment to this address goes through.";
    case "workspace.two_approvals":
      return "The agent decides it again on its own if an owner raises the figure for two approvals to its amount or more, or turns it off.";
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
    case "counterparty.no_address":
      return "the counterparty has no payment address yet";
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
    case "workspace.two_approvals":
      return "payments above the workspace's figure need two people's approval";
    case SHADOW_VERDICT:
      return "shadow mode waits for a person to agree";
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
