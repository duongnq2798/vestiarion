import type { DuplicateMatch } from "./duplicates";
import { blockingDuplicate } from "./duplicates";
import { addressUnconfirmed } from "../counterparty-address";
import { BRIDGE_FEE_CAP_PERCENT } from "../payee-chains";
import { SWAP_COST_CAP_PERCENT } from "../fx/swap-limits";
import { exceedsBudget, type BudgetRoom } from "./outflow-budget";
import type { SpendingLimitVerdict } from "../spending-limit/onchain";
import { TWO_APPROVALS_RULE } from "../two-approvals";

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
    /** Whether the network has a faucet to fund EURC from (mainnet copy C2): Arc testnet's, none on Arc mainnet. */
    faucet: boolean;
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
  /** The counterparty's role (`vendor`, `contractor`, `client`): a client pays the business, so a payable to one waits for a person. */
  counterpartyRole?: string | null;
  /**
   * The spending limit enforced on Arc (onchain spending limit R4, R7), null when the workspace does not enforce it:
   * whether this payment can go through the contract (and why not), and the contract's verdict on it, null when it
   * was not asked.
   */
  onChainLimit?: OnChainLimitCheck | null;
  /**
   * The invoice's three-way match (three-way match design M1): its purchase order, whether the goods were received,
   * and whether its counterparty needs a purchase order at all. Absent where a caller has no invoice to match.
   */
  match?: { poReference: string | null; goodsReceived: boolean; purchaseOrderRequired: boolean } | null;
  /**
   * For the first payment to the counterparty's address in a live workspace: whether two different parties stand
   * behind the address (new payee check N3). Null or absent for a payment that is not a first, or in a sandbox.
   */
  newPayee?: { twoParties: boolean } | null;
  /**
   * The workspace's figure above which a payment needs two people's approval (two approvals T3), in USDC; null or absent
   * when none is set. `amount` is weighed against it, a EURC payment's USDC value included.
   */
  twoApprovalsAbove?: number | null;
}

/** What the spending limit contract says about one payment the agent would make now. */
export interface OnChainLimitCheck {
  covered: boolean;
  uncoveredBecause?: "eurc" | "another_chain";
  verdict: SpendingLimitVerdict | null;
}

export type ApGuardrailRule =
  | "counterparty.high_risk"
  | "counterparty.unscreened"
  | "counterparty.client_payable"
  | "counterparty.payment_limit"
  | "counterparty.address_unconfirmed"
  | "invoice.duplicate_of_settled"
  | "invoice.match_incomplete"
  | "counterparty.new_payee"
  | "fx.rate_unavailable"
  | "treasury.insufficient_eurc"
  | "fx.swap_cost_above_cap"
  | "fx.swap_usdc_short"
  | "bridge.unsupported_token"
  | "bridge.fee_unavailable"
  | "bridge.fee_above_cap"
  | "bridge.gateway_balance_short"
  | typeof TWO_APPROVALS_RULE
  | "workspace.outflow_budget"
  | "workspace.onchain_limit_route"
  | "workspace.onchain_limit";

export { BRIDGE_FEE_CAP_PERCENT };

export interface ApGuardrailResult {
  blocked: boolean;
  status: "held" | "flagged" | "awaiting_info" | null;
  rule: ApGuardrailRule | null;
  reasoning: string;
}

/** What an incomplete match lacks, in words, or null when it is complete or there is nothing to match. */
function matchGaps(match: ApGuardrailInput["match"]): string | null {
  if (!match) return null;
  const gaps: string[] = [];
  if (match.purchaseOrderRequired && !match.poReference?.trim()) gaps.push("no purchase order is on file");
  if (!match.goodsReceived) gaps.push("the goods are not confirmed received");
  return gaps.length > 0 ? gaps.join(" and ") : null;
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

/** What the spending limit contract's refusal says, in a sentence's middle: its own figures, or what it refused. */
export function onChainRefusalClause(verdict: Extract<SpendingLimitVerdict, { state: "refused" }>): string {
  if (verdict.error === "OverDailyLimit" && "spent" in verdict) return `${verdict.spent} USDC already paid today against its ${verdict.limit} USDC daily limit`;
  if (verdict.error === "OverWeeklyLimit" && "spent" in verdict) return `${verdict.spent} USDC paid in the last 7 days against its ${verdict.limit} USDC 7-day limit`;
  if (verdict.error === "AlreadyPaid") return "this payment was already made through it";
  return `it answers ${verdict.error}`;
}

/**
 * The two checks of the spending limit enforced on Arc (onchain spending limit R4, R7), for a payment now: one the
 * contract cannot carry is held for a person; one it would refuse is held with its figures. A verdict that could not
 * be read stops nothing: the contract itself still refuses at send time (R9).
 */
export function onChainLimitHold(check: OnChainLimitCheck | null | undefined, reasoning: string): { rule: "workspace.onchain_limit_route" | "workspace.onchain_limit"; reasoning: string } | null {
  if (!check) return null;
  if (!check.covered) {
    const what = check.uncoveredBecause === "eurc" ? "a payment in EURC" : "a payment to a payee on another chain";
    return {
      rule: "workspace.onchain_limit_route",
      reasoning: `${reasoning} [guardrail override: the agent's spending limit is enforced on Arc, and ${what} cannot go through its contract — held for a person to approve]`,
    };
  }
  if (check.verdict?.state === "refused") {
    return {
      rule: "workspace.onchain_limit",
      reasoning: `${reasoning} [guardrail override: the spending limit contract on Arc would refuse this payment: ${onChainRefusalClause(check.verdict)} — nothing was sent; held for a person to approve]`,
    };
  }
  return null;
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
  // A counterparty no screening has given a verdict on (unscreened hold R1, R2): screening could not run when it was
  // added. Its limit means nothing yet, so it is paid nothing, now or on a date, until screening answers.
  if (input.riskLevel === "unscreened") {
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.unscreened",
      reasoning: `${input.reasoning} [guardrail override: counterparty has not been screened yet — ${verb} refused before execution; decided again once screening gives a verdict]`,
    };
  }
  // A client pays the business: a payable to one is nearly always an invoice entered in the wrong direction. The agent
  // never pays it on its own; a refund is a person's decision, in Approvals (client payables R1).
  if (input.counterpartyRole === "client") {
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.client_payable",
      reasoning: `${input.reasoning} [guardrail override: the counterparty is a client, which pays this business — ${verb} refused before execution; a person pays it in Approvals if it is a refund]`,
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
  // The three-way match (three-way match design M1, M3): the goods received and, for a counterparty that needs one, a
  // purchase order on file. Whether one is needed is the business's rule, set on the counterparty, never the model's to
  // waive. An incomplete match waits for its details, as the written policy's request for information does.
  const gaps = matchGaps(input.match);
  if (gaps) {
    return {
      blocked: true,
      status: "awaiting_info",
      rule: "invoice.match_incomplete",
      reasoning: `${input.reasoning} [guardrail override: the three-way match is incomplete: ${gaps} — ${verb} refused before execution; it waits for the details in Approvals]`,
    };
  }
  // The first payment to an address one party alone stands behind (new payee check N3): code never makes it. A person
  // other than whoever gave the address approves it, and after that the agent pays the address on its own.
  if (input.newPayee && !input.newPayee.twoParties) {
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.new_payee",
      reasoning: `${input.reasoning} [guardrail override: this is the first payment to this address, and only one person stands behind it — ${verb} refused before execution; another person approves it]`,
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
  // Two people's approval above the workspace's figure (two approvals T3): the agent never pays it, now or on a date. After
  // the payment's own checks, and ahead of the spending limit and any EURC swap, so no room is used and no swap is made
  // for a payment the agent may not make.
  const above = input.twoApprovalsAbove ?? null;
  if (above !== null && input.amount > above) {
    return {
      blocked: true,
      status: "held",
      rule: TWO_APPROVALS_RULE,
      reasoning: `${input.reasoning} [guardrail override: payments above ${above} USDC need two people's approval in this workspace — ${verb} refused before execution; two people approve it in Approvals]`,
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
  // The same limit on Arc (onchain spending limit R4, R7): after the code's own check, which speaks first (R8),
  // and ahead of the EURC funding below, so no swap is made for a payment the contract cannot carry.
  const onChain = input.action === "pay" ? onChainLimitHold(input.onChainLimit, input.reasoning) : null;
  if (onChain) return { blocked: true, status: "held", rule: onChain.rule, reasoning: onChain.reasoning };
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
            : `${input.reasoning} [guardrail override: the operating wallet holds ${input.eurcShort.balance} EURC, less than the ${input.eurcShort.needed} EURC this payment sends — held for a person; ${input.eurcShort.faucet ? "fund EURC from Circle's faucet first" : "fund EURC first"}]`,
    };
  }
  return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
}
