import type { DuplicateMatch } from "./duplicates";
import { blockingDuplicate } from "./duplicates";
import { addressUnconfirmed } from "../counterparty-address";
import { BRIDGE_FEE_CAP_PERCENT } from "../payee-chains";
import { SWAP_COST_CAP_PERCENT } from "../fx/swap-limits";
import { exceedsBudget, type BudgetRoom } from "./outflow-budget";

export interface ApGuardrailInput {
  action: "pay" | "schedule" | "hold" | "flag_fraud" | "request_info";
  reasoning: string;
  amount: number;
  riskLevel: string;
  paymentLimit: number | null;
  /** Reportable repeats of this invoice, strongest first. */
  duplicates?: DuplicateMatch[];
  /** When a person last changed the counterparty's address; null when it was set as the counterparty was added. */
  addressChangedAt?: string | null;
  /** When a person last confirmed the counterparty's address. */
  addressConfirmedAt?: string | null;
  /**
   * The invoice's currency (EURC invoices design). For EURC, `amount` is its
   * USDC value at the quoted rate, which is what counts against the limit;
   * `fxAvailable` false means there was no quote, so there is no USDC value.
   */
  currency?: "USDC" | "EURC";
  fxAvailable?: boolean;
  /**
   * A payee on another chain, paid through CCTP (CCTP payouts X4–X6): the fee
   * as a percent of the amount (null when Iris gave none), and whether the
   * invoice is in a token that does not cross. Null for a payee on Arc.
   */
  bridge?: {
    feePercent: number | null;
    unsupportedToken: boolean;
    /** The route the fee is for (Gateway payouts G2); CCTP when not given. */
    route?: "cctp" | "gateway";
    /** A payout an earlier attempt sent through Gateway, which the Gateway balance no longer covers (review I3). */
    gatewayShort?: { balanceUsdc: number; neededUsdc: number } | null;
  } | null;
  /** A live EURC payment the wallet's EURC cannot cover: what it holds (null when it could not be read) and what the payment sends. */
  eurcShort?: {
    balance: number | null;
    needed: number;
    /**
     * The swap of USDC for EURC that could fund it (EURC swap spec S5): whether the model chose it
     * (`fundWithSwap`), the offer (null when there was none to make), and the USDC it would leave
     * against what falls due in USDC within 7 days.
     */
    swap?: { requested: boolean; offer: { usdcIn: number; costPercent: number } | null; usdcBalance: number; usdcDueWithin7Days: number };
  } | null;
  /**
   * What the agent's spending limit leaves this cycle (outflow budget spec R4, R5), null when the
   * workspace set none. `amount` is weighed against `remaining`.
   */
  outflowBudget?: BudgetRoom | null;
}

export type ApGuardrailRule =
  | "counterparty.high_risk"
  | "counterparty.payment_limit"
  | "counterparty.address_unconfirmed"
  | "invoice.duplicate_of_settled"
  | "fx.rate_unavailable"
  | "treasury.insufficient_eurc"
  | "fx.swap_cost_above_cap"
  | "fx.swap_usdc_short"
  | "bridge.unsupported_token"
  | "bridge.fee_unavailable"
  | "bridge.fee_above_cap"
  | "bridge.gateway_balance_short"
  | "workspace.outflow_budget";

export { BRIDGE_FEE_CAP_PERCENT };

export interface ApGuardrailResult {
  blocked: boolean;
  status: "held" | "flagged" | null;
  rule: ApGuardrailRule | null;
  reasoning: string;
}

function routeName(bridge: NonNullable<ApGuardrailInput["bridge"]>): string {
  return bridge.route === "gateway" ? "Gateway" : "CCTP";
}

/** Which figure of the spending limit stops a payment, and what the agent already paid against it. */
export function budgetClause(budget: BudgetRoom): string {
  return budget.binding === "day"
    ? `its ${budget.dailyUsdc} USDC daily spending limit: ${budget.spentToday} USDC already paid today`
    : `its ${budget.weeklyUsdc} USDC 7-day spending limit: ${budget.spentThisWeek} USDC already paid in the last 7 days`;
}

/** The final code boundary between a model's recommendation and execution. */
export function enforceApGuardrails(input: ApGuardrailInput): ApGuardrailResult {
  if (input.action !== "pay" && input.action !== "schedule") {
    return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
  }
  // A payment the agent commits to must be one it would be allowed to make:
  // every check below applies to `schedule` exactly as it does to `pay`. Only
  // the wording of a refusal changes, so a person reading the ledger sees
  // what was actually refused.
  const verb = input.action === "schedule" ? "scheduling" : "payment";

  // Checked before risk and limit because a duplicate is the one failure where
  // every other check legitimately passes: the counterparty is clear, the
  // amount is within its limit, the purchase order matches and the goods were
  // received — because all of that was true the first time the bill was paid.
  const duplicate = blockingDuplicate(input.duplicates ?? []);
  if (duplicate) {
    return {
      blocked: true,
      status: "flagged",
      rule: "invoice.duplicate_of_settled",
      reasoning: `${input.reasoning} [guardrail override: this invoice repeats one already paid, being paid, scheduled or being decided by a person (${duplicate.explanation}) — ${verb} refused before execution]`,
    };
  }

  if (input.riskLevel === "high") {
    return {
      blocked: true,
      status: "flagged",
      rule: "counterparty.high_risk",
      reasoning: `${input.reasoning} [guardrail override: counterparty is high risk — ${verb} refused before execution]`,
    };
  }
  // Ahead of the limit so the reason names the change: an edited address is
  // the classic payment-redirection fraud, and whatever the amount, the first
  // payment to it waits for a person.
  const changedAt = input.addressChangedAt ?? null;
  if (addressUnconfirmed(changedAt, input.addressConfirmedAt ?? null)) {
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.address_unconfirmed",
      reasoning: `${input.reasoning} [guardrail override: the counterparty's address changed on ${(changedAt as string).slice(0, 10)} and no one has confirmed it — held for a person to approve]`,
    };
  }
  // A EURC payable with no quote has no USDC value, so its limit cannot be
  // checked: it waits for a person, who sees the EURC amount (E4).
  if (input.currency === "EURC" && input.fxAvailable === false) {
    return {
      blocked: true,
      status: "held",
      rule: "fx.rate_unavailable",
      reasoning: `${input.reasoning} [guardrail override: no EURC→USDC rate from Circle's Stablecoin Service, so the payment limit cannot be checked — held for a person to approve]`,
    };
  }
  if (input.paymentLimit != null && input.amount > input.paymentLimit) {
    const amount = input.currency === "EURC" ? `its USDC value at the quoted rate, ${input.amount} USDC,` : "amount";
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.payment_limit",
      reasoning: `${input.reasoning} [guardrail override: ${amount} exceeds the ${input.paymentLimit} USDC payment limit — ${verb} refused before execution]`,
    };
  }
  // A payee on another chain is paid through CCTP: USDC only, at a fee code
  // has read and that is worth paying (CCTP payouts X4–X6).
  if (input.bridge?.unsupportedToken) {
    return {
      blocked: true,
      status: "held",
      rule: "bridge.unsupported_token",
      reasoning: `${input.reasoning} [guardrail override: only USDC crosses chains, and this invoice is in EURC — ${verb} to a payee on another chain refused; held for a person]`,
    };
  }
  if (input.bridge && input.bridge.feePercent === null) {
    return {
      blocked: true,
      status: "held",
      rule: "bridge.fee_unavailable",
      reasoning: `${input.reasoning} [guardrail override: Circle gave no ${routeName(input.bridge)} fee for this payee's chain, so its cost is not known — held for a person]`,
    };
  }
  if (input.bridge && input.bridge.feePercent !== null && input.bridge.feePercent > BRIDGE_FEE_CAP_PERCENT) {
    return {
      blocked: true,
      status: "held",
      rule: "bridge.fee_above_cap",
      reasoning: `${input.reasoning} [guardrail override: the ${routeName(input.bridge)} fee is ${input.bridge.feePercent.toFixed(2)}% of the amount, above the ${BRIDGE_FEE_CAP_PERCENT}% a payout may cost — ${verb} refused before execution]`,
    };
  }
  // A payout keeps the route its first attempt took: one sent through Gateway
  // is never sent again through CCTP, so a Gateway balance that no longer
  // covers it waits for a person (Gateway payouts review I3).
  if (input.bridge?.gatewayShort) {
    return {
      blocked: true,
      status: "held",
      rule: "bridge.gateway_balance_short",
      reasoning: `${input.reasoning} [guardrail override: an earlier attempt went through Gateway, and the Gateway balance, ${input.bridge.gatewayShort.balanceUsdc} USDC, does not cover the ${input.bridge.gatewayShort.neededUsdc} USDC this payout needs with its fee — ${verb} refused; held for a person to check the earlier transfer with Circle]`,
    };
  }
  // The agent's spending limit (outflow budget spec R4): what it may pay on its own today and in 7
  // days. Only a payment now: a schedule is decided again, with this check, on its day. Ahead of the
  // EURC funding below, so no swap is made for a payment the limit would refuse.
  const budget = input.outflowBudget ?? null;
  if (input.action === "pay" && exceedsBudget(input.amount, budget)) {
    return {
      blocked: true,
      status: "held",
      rule: "workspace.outflow_budget",
      reasoning: `${input.reasoning} [guardrail override: paying ${input.amount} USDC would take the agent past ${budgetClause(budget)}, ${budget.remaining} USDC left — held for a person to approve]`,
    };
  }
  // A EURC invoice is paid from EURC, never sent as USDC (E5). A payment the
  // wallet's EURC cannot cover waits for a person, unless the model chose to
  // fund it with the swap it was offered, within the swap's two bounds (EURC
  // swap spec S5): its cost above the rate the payable was weighed at, and
  // the USDC it leaves for what falls due in USDC within 7 days.
  const swap = input.eurcShort?.swap;
  if (input.action === "pay" && input.eurcShort && input.eurcShort.balance !== null && swap?.requested && swap.offer) {
    if (swap.offer.costPercent > SWAP_COST_CAP_PERCENT) {
      return {
        blocked: true,
        status: "held",
        rule: "fx.swap_cost_above_cap",
        reasoning: `${input.reasoning} [guardrail override: the swap of ${swap.offer.usdcIn} USDC for the EURC this payment needs costs ${swap.offer.costPercent}% above the rate it was weighed at, more than the ${SWAP_COST_CAP_PERCENT}% a swap may cost — payment refused before execution]`,
      };
    }
    const left = Math.round((swap.usdcBalance - swap.offer.usdcIn) * 1_000_000) / 1_000_000;
    if (left < swap.usdcDueWithin7Days) {
      return {
        blocked: true,
        status: "held",
        rule: "fx.swap_usdc_short",
        reasoning: `${input.reasoning} [guardrail override: swapping ${swap.offer.usdcIn} USDC would leave ${left} USDC, less than the ${swap.usdcDueWithin7Days} USDC due within 7 days — payment refused before execution]`,
      };
    }
    return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
  }
  if (input.action === "pay" && input.eurcShort) {
    return {
      blocked: true,
      status: "held",
      rule: "treasury.insufficient_eurc",
      reasoning:
        input.eurcShort.balance === null
          ? `${input.reasoning} [guardrail override: the operating wallet's EURC could not be read, so the ${input.eurcShort.needed} EURC this payment sends cannot be checked — held for a person]`
          : swap?.requested
            ? `${input.reasoning} [guardrail override: the operating wallet holds ${input.eurcShort.balance} EURC, less than the ${input.eurcShort.needed} EURC this payment sends, and no swap was available to fund it — held for a person]`
            : `${input.reasoning} [guardrail override: the operating wallet holds ${input.eurcShort.balance} EURC, less than the ${input.eurcShort.needed} EURC this payment sends — held for a person; fund EURC from Circle's faucet first]`,
    };
  }
  return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
}
