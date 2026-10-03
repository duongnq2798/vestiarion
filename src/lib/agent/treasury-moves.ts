import crypto from "node:crypto";
import type { ChainProvider } from "../circle";
import type { UsycExecution } from "../circle/types";
import { UsycSubscriptionsClosedError } from "../circle/usyc";
import type { OrgDb } from "../dal";
import { pausedTreasuryNote } from "./pause";
import { boundTreasuryMove, type TreasuryBound, type TreasuryDecision, type TreasuryPlan } from "./treasury";

/**
 * Moving cash between the operating wallet and the reserve: the treasury stage's sweep or redemption, the cycle's
 * liquidity step before payments (reserve cash back R3), and a person's Bring cash back (R2). Moved out of the
 * orchestrator so all three share one call, with its pause check, keys and balance updates.
 */

/** What the treasury stage's attempted move decided — mirrors `PayStepOutcome`
 * but in the treasury stage's own vocabulary (`executed`/`executionNote`,
 * already what it recorded before this existed). */
export interface TreasuryMoveOutcome {
  executed: boolean;
  executionNote: string | null;
  heldBecausePaused: boolean;
  /** A real USYC move's transactions (USYC live design R7); absent for a simulated one. */
  execution?: UsycExecution;
}

/**
 * The treasury stage's move, once a sweep or redemption has actually been
 * decided (a `"hold"` decision, or one with a non-positive amount, never
 * reaches here and is reported as not executed with no note, exactly as
 * before): hold — nothing moves — if the agent is paused since the decision
 * was made, `provider.depositToEarn`/`withdrawFromEarn` never called;
 * otherwise move and update the reserve balance exactly as before.
 *
 * Mirrors `payApInvoiceIfNotPaused`/`releaseMilestoneIfNotPaused` above for
 * the same reason (ruling R5): this exact call site is unit-testable without
 * a full cycle.
 */
export async function moveTreasuryIfNotPaused(
  decision: TreasuryDecision,
  ctx: {
    db: OrgDb;
    provider: ChainProvider;
    operatingAccountId: string;
    reserveAccountId: string;
    operatingBalance: number;
    reserveBalance: number;
    /** The seed of a real move's idempotency keys: the cycle, so a retried cycle never moves twice (USYC live R6). */
    moveKey?: string;
    /** A person's own move (reserve cash back R2): the agent's pause holds the agent, not them. */
    byPerson?: boolean;
  }
): Promise<TreasuryMoveOutcome> {
  const wouldMove =
    (decision.action === "sweep_to_usyc" || decision.action === "redeem_from_usyc") && decision.amount > 0;
  if (!wouldMove) {
    return { executed: false, executionNote: null, heldBecausePaused: false };
  }

  const pauseNote = ctx.byPerson ? null : await pausedTreasuryNote();
  if (pauseNote) {
    return { executed: false, executionNote: pauseNote, heldBecausePaused: true };
  }

  const live = ctx.provider.earnMode === "live";
  const move = {
    accountId: ctx.operatingAccountId,
    reserveAccountId: ctx.reserveAccountId,
    key: `${ctx.moveKey ?? crypto.randomUUID()}/${decision.action}`,
  };
  try {
    let execution: UsycExecution | undefined;
    if (decision.action === "sweep_to_usyc") {
      const amount = Math.min(decision.amount, ctx.operatingBalance);
      execution = (await ctx.provider.depositToEarn({ ...move, amount })).execution;
      const res = await ctx.db
        .from("accounts")
        .update({ balance: Number((ctx.reserveBalance + amount).toFixed(6)) })
        .eq("id", ctx.reserveAccountId);
      if (res.error) throw new Error(res.error.message);
    } else {
      const amount = Math.min(decision.amount, ctx.reserveBalance);
      execution = (await ctx.provider.withdrawFromEarn({ ...move, amount })).execution;
      const res = await ctx.db
        .from("accounts")
        .update({ balance: Number((ctx.reserveBalance - amount).toFixed(6)) })
        .eq("id", ctx.reserveAccountId);
      if (res.error) throw new Error(res.error.message);
    }
    // A real move changed both wallets on chain: the stored figures follow from the chain at once
    // (R3), best effort, since the next reconcile reads them again either way.
    if (live) await refreshTreasuryBalances(ctx);
    return { executed: true, executionNote: null, heldBecausePaused: false, ...(execution ? { execution } : {}) };
  } catch (err) {
    if (err instanceof UsycSubscriptionsClosedError) return { executed: false, executionNote: err.message, heldBecausePaused: false };
    return { executed: false, executionNote: `execution failed: ${(err as Error).message}`, heldBecausePaused: false };
  }
}

/**
 * The agent's own treasury move (treasury move bounds R1–R3): the model's decision bounded by the buffer the policy works
 * out, then moved as any move is. Returns what moved and, when code changed the model's move, the rule, so the stage
 * records the bounded move and counts the override. A person's own move is never bounded (R2): it goes straight to
 * `moveTreasuryIfNotPaused`.
 */
export async function moveAgentTreasury(
  decision: TreasuryDecision,
  plan: TreasuryPlan,
  ctx: Parameters<typeof moveTreasuryIfNotPaused>[1]
): Promise<TreasuryMoveOutcome & TreasuryBound> {
  const bounded = boundTreasuryMove(decision, plan, ctx.reserveBalance);
  return { ...(await moveTreasuryIfNotPaused(bounded.decision, ctx)), ...bounded };
}

/** The operating wallet's USDC and the reserve's USYC value, read from the chain after a real move (USYC live R3). */
async function refreshTreasuryBalances(ctx: { db: OrgDb; provider: ChainProvider; operatingAccountId: string; reserveAccountId: string }): Promise<void> {
  try {
    const [operating, reserve] = await Promise.all([
      ctx.provider.getBalance(ctx.operatingAccountId),
      ctx.provider.getEarnPosition ? ctx.provider.getEarnPosition(ctx.reserveAccountId) : Promise.resolve(null),
    ]);
    const writes = [ctx.db.from("accounts").update({ balance: operating.balance }).eq("id", ctx.operatingAccountId)];
    if (reserve) writes.push(ctx.db.from("accounts").update({ balance: reserve.valueUsdc }).eq("id", ctx.reserveAccountId));
    for (const res of await Promise.all(writes)) if (res.error) throw new Error(res.error.message);
  } catch (error) {
    console.error("treasury: balances not read again after a USYC move", error instanceof Error ? error.message : error);
  }
}
