/**
 * The treasury policy, as a pure function.
 *
 * The rule this encodes is the one a competent treasurer applies and a cron
 * job cannot: **move the money only when moving it pays for itself.** Sweeping
 * into USYC and redeeming back out are two transactions. If the yield earned
 * between now and the day the cash is next needed is smaller than those fees,
 * sweeping destroys value, however idle the balance looks.
 *
 * Before this existed the heuristic swept whenever idle cash exceeded a bare
 * `100`, which is a number with no units and no relationship to anything. At
 * the scale live testnet runs at — tens of USDC — it never fired, and the
 * README had to explain away why. The economics are the explanation; they
 * belong in the code.
 *
 * Kept free of I/O so the whole policy surface can be tested directly, and so
 * the same numbers can be handed to the LLM as context rather than recomputed
 * in a prompt string.
 */

export interface TreasuryDecision {
  action: "sweep_to_usyc" | "redeem_from_usyc" | "hold";
  amount: number;
  reasoning: string;
}

export interface TreasuryInputs {
  operatingBalance: number;
  reserveBalance: number;
  /** Annualised, as a fraction: 0.045 for 4.5%. */
  apy: number;
  /** Payables due inside the buffer window, plus every open milestone. */
  obligationsDue7d: number;
  /** Days until the soonest obligation. `Infinity` when nothing is outstanding. */
  daysUntilNextObligation: number;
  /** Cost of a sweep plus the redemption that must follow it. */
  roundTripCostUsd: number;
  /** Cushion held over the obligations themselves. 1.15 = 15%. */
  bufferRatio?: number;
}

export interface TreasuryPlan {
  decision: TreasuryDecision;
  /** Cash above the buffer. Negative means the buffer is already breached. */
  idle: number;
  buffer: number;
  /** Days the swept cash could realistically stay in the reserve. */
  holdDays: number;
  projectedYieldUsd: number;
  roundTripCostUsd: number;
}

/**
 * Cash swept today is redeemed when the next obligation comes due, so that is
 * the horizon the yield has to beat the fees over. Capped at 30 days because
 * a forecast further out than a month is not evidence, and floored at 1
 * because same-day round trips still cost two transactions.
 */
export function expectedHoldDays(daysUntilNextObligation: number): number {
  if (!Number.isFinite(daysUntilNextObligation)) return 30;
  return Math.min(30, Math.max(1, daysUntilNextObligation));
}

/** Truncates toward zero at USDC's six decimals; never rounds a balance up. */
export function toUsdc(value: number): number {
  return Math.trunc(value * 1e6) / 1e6;
}

export function planTreasury(input: TreasuryInputs): TreasuryPlan {
  const bufferRatio = input.bufferRatio ?? 1.15;
  const buffer = toUsdc(input.obligationsDue7d * bufferRatio);
  const idle = toUsdc(input.operatingBalance - buffer);
  const holdDays = expectedHoldDays(input.daysUntilNextObligation);

  const base = { idle, buffer, holdDays, roundTripCostUsd: input.roundTripCostUsd };

  if (idle < 0) {
    const shortfall = toUsdc(-idle);
    if (input.reserveBalance > 0) {
      const amount = toUsdc(Math.min(shortfall, input.reserveBalance));
      return {
        ...base,
        projectedYieldUsd: 0,
        decision: {
          action: "redeem_from_usyc",
          amount,
          reasoning:
            `Operating balance ${input.operatingBalance} USDC is ${shortfall} USDC short of the ` +
            `${buffer} USDC buffer over ${input.obligationsDue7d} USDC of obligations due within 7 days; ` +
            `redeeming ${amount} USDC from the reserve ahead of the due dates rather than after them.`,
        },
      };
    }
    return {
      ...base,
      projectedYieldUsd: 0,
      decision: {
        action: "hold",
        amount: 0,
        reasoning:
          `Operating balance ${input.operatingBalance} USDC is ${shortfall} USDC short of the ` +
          `${buffer} USDC obligation buffer and the reserve is empty, so there is nothing to redeem. ` +
          `Flagging the gap rather than moving money that is not there.`,
      },
    };
  }

  const amount = toUsdc(idle);
  const projectedYieldUsd = toUsdc((amount * input.apy * holdDays) / 365);

  if (amount > 0 && projectedYieldUsd > input.roundTripCostUsd) {
    return {
      ...base,
      projectedYieldUsd,
      decision: {
        action: "sweep_to_usyc",
        amount,
        reasoning:
          `${amount} USDC sits above the ${buffer} USDC buffer for the ${input.obligationsDue7d} USDC ` +
          `due within 7 days. At ${(input.apy * 100).toFixed(2)}% APY over the ${holdDays} day(s) until ` +
          `the next obligation that earns about $${projectedYieldUsd.toFixed(4)}, against $` +
          `${input.roundTripCostUsd.toFixed(4)} in sweep-and-redeem fees — so the sweep pays for itself.`,
      },
    };
  }

  if (amount > 0) {
    return {
      ...base,
      projectedYieldUsd,
      decision: {
        action: "hold",
        amount: 0,
        reasoning:
          `${amount} USDC is idle above the ${buffer} USDC buffer, but at ${(input.apy * 100).toFixed(2)}% ` +
          `APY over the ${holdDays} day(s) until the next obligation it would earn about $` +
          `${projectedYieldUsd.toFixed(4)} — less than the $${input.roundTripCostUsd.toFixed(4)} round-trip ` +
          `fee. Sweeping would cost more than it earns, so the cash stays liquid.`,
      },
    };
  }

  return {
    ...base,
    projectedYieldUsd: 0,
    decision: {
      action: "hold",
      amount: 0,
      reasoning:
        `Operating balance ${input.operatingBalance} USDC sits exactly at the ${buffer} USDC buffer for ` +
        `${input.obligationsDue7d} USDC of obligations due within 7 days; no cash is idle.`,
    },
  };
}

const AGREE_TOLERANCE_USDC = 0.01;
const AGREE_TOLERANCE_SHARE = 0.05;
const EPSILON = 0.0000005;

/**
 * Two treasury decisions agree when they make the same move for about the same amount: within 5% of the written
 * policy's, or 0.01 USDC (treasury bounds R4). A redemption of the whole reserve where the policy redeems a buffer's
 * worth is a different decision, however alike the action's name.
 */
export function sameTreasuryDecision(model: TreasuryDecision, reference: TreasuryDecision): boolean {
  if (model.action !== reference.action) return false;
  if (model.action === "hold") return true;
  return Math.abs(model.amount - reference.amount) <= Math.max(AGREE_TOLERANCE_USDC, AGREE_TOLERANCE_SHARE * Math.abs(reference.amount));
}

export interface TreasuryBoundFacts {
  operatingBalance: number;
  reserveBalance: number;
  obligationsDue14d: number;
  plan: TreasuryPlan;
  /** The written policy's decision, which a redemption never falls short of. */
  reference: TreasuryDecision;
  bufferRatio?: number;
}

/** The most a sweep may take, and the most and least a redemption may bring back (treasury bounds R1–R3). */
export function treasuryBounds(facts: TreasuryBoundFacts): { sweepAtMost: number; redeemAtMost: number; redeemAtLeast: number } {
  const ratio = facts.bufferRatio ?? 1.15;
  const sweepAtMost = toUsdc(Math.min(Math.max(0, facts.plan.idle), facts.operatingBalance));
  const need = toUsdc(Math.max(0, facts.obligationsDue14d * ratio - facts.operatingBalance));
  const redeemAtLeast = facts.reference.action === "redeem_from_usyc" ? facts.reference.amount : 0;
  const redeemAtMost = toUsdc(Math.min(facts.reserveBalance, Math.max(need, redeemAtLeast)));
  return { sweepAtMost, redeemAtMost, redeemAtLeast };
}

/**
 * What code lets the model's move be (treasury bounds R1–R3), and why, when it changed it:
 * - a sweep takes only the cash above the 7-day buffer, so it never leaves the operating wallet short of what falls
 *   due within 7 days;
 * - a redemption brings back at most what falls due within 14 days needs, with the same cushion, less what the
 *   operating wallet holds, and at least what the written policy redeems to restore the buffer.
 * A hold is the model's to make. Money moves only between the workspace's own wallets either way; the bounds keep the
 * reserve doing its job.
 */
export function boundTreasuryDecision(model: TreasuryDecision, facts: TreasuryBoundFacts): { decision: TreasuryDecision; limited: string | null } {
  const limitedTo = (decision: TreasuryDecision, why: string) => ({
    decision: { ...decision, reasoning: `${model.reasoning} [Code limited this: ${why}.]` },
    limited: why,
  });
  const bounds = treasuryBounds(facts);
  if (model.action === "sweep_to_usyc") {
    const allowed = bounds.sweepAtMost;
    if (allowed <= 0) {
      return limitedTo({ action: "hold", amount: 0, reasoning: "" }, `a sweep of ${model.amount} USDC would take the operating wallet below its ${facts.plan.buffer} USDC buffer, so nothing was swept`);
    }
    if (model.amount > allowed + EPSILON) {
      return limitedTo(
        { action: "sweep_to_usyc", amount: allowed, reasoning: "" },
        `a sweep of ${model.amount} USDC would take the operating wallet below its ${facts.plan.buffer} USDC buffer, so only the ${allowed} USDC above it was swept`
      );
    }
    return { decision: model, limited: null };
  }
  if (model.action === "redeem_from_usyc") {
    const floor = bounds.redeemAtLeast;
    const ceiling = bounds.redeemAtMost;
    if (ceiling <= 0) {
      return limitedTo({ action: "hold", amount: 0, reasoning: "" }, `nothing falling due within 14 days needs cash from the reserve, so nothing was redeemed`);
    }
    if (model.amount > ceiling + EPSILON) {
      return limitedTo(
        { action: "redeem_from_usyc", amount: ceiling, reasoning: "" },
        `${model.amount} USDC is more than the ${ceiling} USDC what falls due within 14 days needs, with its cushion, so ${ceiling} USDC was redeemed`
      );
    }
    if (model.amount + EPSILON < floor) {
      return limitedTo(
        { action: "redeem_from_usyc", amount: floor, reasoning: "" },
        `${model.amount} USDC would leave the operating wallet below its ${facts.plan.buffer} USDC buffer, so the ${floor} USDC the written policy redeems was redeemed`
      );
    }
    return { decision: model, limited: null };
  }
  return { decision: model, limited: null };
}
