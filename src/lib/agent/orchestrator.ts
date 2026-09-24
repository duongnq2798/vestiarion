import { z } from "zod";
import { supabase, unwrap } from "../supabase";
import { appendLedgerEntry } from "../ledger";
import { getChainProvider } from "../circle";
import { cycleClockMode, type CycleClockMode } from "../clock";
import { runComplianceSweep } from "../compliance";
import { refreshGitHubMilestones } from "../milestone-verification";
import { seedScale } from "../seed";
import { executePayment } from "../payments";
import { decide } from "./decide";
import { enforceApGuardrails } from "./guardrails";
import { OPEN_PAYABLE_STATUSES, summarizePayableObligations } from "./obligations";
import { planTreasury, type TreasuryDecision } from "./treasury";

const SYSTEM_PROMPT = `You are Vestiarion, an autonomous treasury agent operating a small business's money on the Arc blockchain, settled in USDC. You hold real spending authority inside the guardrails below.

Rules you must follow:
- Never pay a counterparty whose risk level is "high".
- Never authorise an amount above the counterparty's current payment limit.
- When a three-way match is incomplete (no purchase order on file, or goods not confirmed received), request information instead of paying.
- When evidence suggests fraud — a duplicate invoice, a mismatched PO, a counterparty whose risk just changed — flag it rather than holding quietly.
- Keep enough liquid operating cash to cover every obligation due in the next 7 days before sweeping anything into yield.
- Your reasoning must cite the specific facts you were given: amounts, PO numbers, risk levels, balances. A human auditor will read it next to the same data. Never write vague justifications like "looks fine" or "seems reasonable".

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const apDecisionSchema = z.object({
  action: z.enum(["pay", "hold", "flag_fraud", "request_info"]),
  reasoning: z.string().min(10),
  confidence: z.number().min(0).max(1),
});
type ApDecision = z.infer<typeof apDecisionSchema>;

const milestoneDecisionSchema = z.object({
  action: z.enum(["release", "hold"]),
  reasoning: z.string().min(10),
  confidence: z.number().min(0).max(1),
});
type MilestoneDecision = z.infer<typeof milestoneDecisionSchema>;

const treasuryDecisionSchema = z.object({
  action: z.enum(["sweep_to_usyc", "redeem_from_usyc", "hold"]),
  amount: z.number().min(0),
  reasoning: z.string().min(10),
});

export interface CycleLogLine {
  domain: string;
  message: string;
}

export interface CycleResult {
  day: number;
  lines: CycleLogLine[];
  mode: string;
  clockMode: CycleClockMode;
  startedAt: string;
  finishedAt: string;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/**
 * Writes the operating account's balance back from whatever the provider
 * considers the chain. In simulate mode the provider already decremented it;
 * in live mode this is the only thing that keeps the stored balance in step
 * with Arc after a transfer. Without it, the treasury step later in the same
 * cycle reasons about money that has already left the wallet.
 *
 * The notional USYC carve-out is applied here for the same reason it is
 * applied during reconciliation — see the comment there.
 */
async function syncOperatingBalance(accountId: string): Promise<number> {
  const db = supabase();
  const provider = getChainProvider();
  const snapshot = await provider.getBalance(accountId);

  let carveOut = 0;
  if (provider.mode === "live" && provider.earnMode === "simulate") {
    const reserve = (
      await db.from("accounts").select("balance").eq("kind", "reserve").maybeSingle()
    ).data as { balance: string } | null;
    carveOut = num(reserve?.balance);
  }

  const spendable = Math.max(0, Number((snapshot.balance - carveOut).toFixed(6)));
  const res = await db.from("accounts").update({ balance: spendable }).eq("id", accountId);
  if (res.error) throw new Error(res.error.message);
  return spendable;
}

/** Where a payment should actually land, or null when the counterparty has no wallet yet. */
function payoutAddress(address: string | null, counterpartyId: string): string {
  return address ?? `sim:${counterpartyId}`;
}

export async function runAgentCycle(): Promise<CycleResult> {
  const db = supabase();
  const provider = getChainProvider();
  const lines: CycleLogLine[] = [];
  const startedAt = new Date().toISOString();
  const clockMode = cycleClockMode();

  const day = clockMode === "simulate"
    ? unwrap(await db.rpc("advance_sim_day").single<number>())
    : unwrap(
        await db.from("sim_clock").select("current_day").eq("id", 1).single<{ current_day: number }>()
      ).current_day;

  // ------------------------------------------------------------ 0. reconcile
  // In live mode the chain is the source of truth for cash. Reading the
  // stored balance instead would let the agent authorise payments against
  // money that is no longer there — the exact failure a treasury agent must
  // not have.
  //
  // While the USYC leg is simulated, the reserve is a *notional* carve-out:
  // those USDC physically remain in the operating wallet. Subtracting it
  // keeps the identity `operating + reserve == on-chain total`, so the
  // reserve cannot conjure a balance that does not exist on Arc.
  if (provider.mode === "live") {
    const rows = unwrap(
      await db.from("accounts").select("id, name, kind, balance")
    ) as Array<{ id: string; name: string; kind: string; balance: string }>;

    const notionalReserve =
      provider.earnMode === "simulate"
        ? num(rows.find((a) => a.kind === "reserve")?.balance)
        : 0;

    for (const account of rows.filter((a) => a.kind !== "reserve")) {
      try {
        const snapshot = await provider.getBalance(account.id);
        const carveOut = account.kind === "operating" ? notionalReserve : 0;
        const spendable = Math.max(0, Number((snapshot.balance - carveOut).toFixed(6)));
        const stored = num(account.balance);
        if (Math.abs(spendable - stored) < 0.000001) continue;

        const res = await db
          .from("accounts")
          .update({ balance: spendable })
          .eq("id", account.id);
        if (res.error) throw new Error(res.error.message);

        const note = carveOut > 0 ? ` (on-chain ${snapshot.balance} less ${carveOut} notional reserve)` : "";
        lines.push({
          domain: "treasury",
          message: `Reconciled ${account.name}: ${stored} → ${spendable} USDC${note}`,
        });
      } catch (err) {
        lines.push({
          domain: "treasury",
          message: `Could not reconcile ${account.name}: ${(err as Error).message}`,
        });
      }
    }
  }

  // ---------------------------------------------------------------- 1. compliance
  // The whole counterparty book, every cycle — not only the ones still marked
  // unscreened. The vendor that screened clear last week is precisely the one
  // worth re-checking; screening once at onboarding is the failure RFB5 names.
  const sweep = await runComplianceSweep();

  if (!sweep.complete) {
    lines.push({
      domain: "compliance",
      message: `Screening incomplete for ${sweep.failures.length} counterparty${sweep.failures.length === 1 ? "" : "ies"}; previous verdicts retained`,
    });
  }

  for (const outcome of sweep.screened) {
    if (outcome.firstScreen) {
      lines.push({
        domain: "compliance",
        message: `Screened ${outcome.name} → ${outcome.riskLevel}`,
      });
    } else if (outcome.changed) {
      lines.push({
        domain: "compliance",
        message: `${outcome.name}: risk ${outcome.previousRiskLevel} → ${outcome.riskLevel}`,
      });
    }
  }

  const unchanged = sweep.screened.filter((s) => !s.changed).length;
  if (unchanged > 0) {
    lines.push({
      domain: "compliance",
      message: `Re-screened ${unchanged} counterpart${unchanged === 1 ? "y" : "ies"}, no change`,
    });
  }

  // GitHub-backed evidence is refreshed before contractor decisions, so a
  // PR merged since the previous run can release in this same cycle. Missing
  // credentials or API failures retain the previous verdict and are labelled.
  const milestoneVerification = await refreshGitHubMilestones();
  if (milestoneVerification.checked > 0) {
    lines.push({
      domain: "contractor",
      message: `Checked ${milestoneVerification.checked} GitHub milestone${milestoneVerification.checked === 1 ? "" : "s"}: ${milestoneVerification.verified} merged, ${milestoneVerification.unavailable} unavailable, ${milestoneVerification.failed} failed`,
    });
  }

  // ------------------------------------------------------------------ shared state
  const accounts = unwrap(await db.from("accounts").select("*")) as Array<{
    id: string;
    kind: string;
    balance: string;
    apy: string;
  }>;
  const operating = accounts.find((a) => a.kind === "operating");
  // Tracked across the AP and contractor loops so each decision sees the
  // balance as it stands after the payments already made this cycle, not as
  // it stood when the cycle began.
  let operatingBalance = num(operating?.balance);

  // ----------------------------------------------------------------------- 2. AP
  const payables = unwrap(
    await db
      .from("invoices")
      .select("*, counterparties(id, name, risk_level, payment_limit, address)")
      .eq("direction", "payable")
      .in("status", ["pending", "matched"])
  ) as Array<{
    id: string;
    amount: string;
    memo: string | null;
    po_reference: string | null;
    goods_received: boolean;
    due_date: string;
    counterparty_id: string;
    counterparties: {
      id: string;
      name: string;
      risk_level: string;
      payment_limit: string | null;
      address: string | null;
    };
  }>;

  for (const invoice of payables) {
    const counterparty = invoice.counterparties;
    const amount = num(invoice.amount);
    const limit = counterparty.payment_limit == null ? null : num(counterparty.payment_limit);
    const overLimit = limit != null && amount > limit;
    const highRisk = counterparty.risk_level === "high";

    const { value: decision, mode } = await decide<ApDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to pay this accounts-payable invoice.",
        invoice: {
          amount,
          memo: invoice.memo,
          poReference: invoice.po_reference,
          goodsReceived: invoice.goods_received,
          dueDate: invoice.due_date,
        },
        counterparty: {
          name: counterparty.name,
          riskLevel: counterparty.risk_level,
          paymentLimit: limit,
        },
        treasury: { operatingBalance },
        responseShape: {
          action: "pay | hold | flag_fraud | request_info",
          reasoning: "string",
          confidence: "number between 0 and 1",
        },
      }),
      schema: apDecisionSchema,
      fallback: (): ApDecision => {
        if (highRisk) {
          return {
            action: "flag_fraud",
            reasoning: `${counterparty.name} is flagged high risk by compliance screening; payment blocked pending human review.`,
            confidence: 0.95,
          };
        }
        if (overLimit) {
          return {
            action: "hold",
            reasoning: `Invoice amount ${amount} USDC exceeds ${counterparty.name}'s payment limit of ${limit} USDC.`,
            confidence: 0.9,
          };
        }
        if (!invoice.goods_received || !invoice.po_reference) {
          return {
            action: "request_info",
            reasoning: `Cannot complete a three-way match: purchase order ${invoice.po_reference ?? "missing"}, goods received ${invoice.goods_received}.`,
            confidence: 0.7,
          };
        }
        return {
          action: "pay",
          reasoning: `PO ${invoice.po_reference} matches, goods confirmed received, ${counterparty.name} screened clear, and ${amount} USDC is within the ${limit} USDC limit.`,
          confidence: 0.85,
        };
      },
    });

    const statusForAction: Record<ApDecision["action"], string> = {
      pay: "paid",
      hold: "held",
      flag_fraud: "flagged",
      request_info: "awaiting_info",
    };

    const guardrail = enforceApGuardrails({
      action: decision.action,
      reasoning: decision.reasoning,
      amount,
      riskLevel: counterparty.risk_level,
      paymentLimit: limit,
    });
    let status = guardrail.status ?? statusForAction[decision.action];
    let txRef: string | null = null;
    let reasoning = guardrail.reasoning;
    const guardrailBlocked = guardrail.blocked;

    if (decision.action === "pay") {
      // The guardrails are enforced here, after the model has spoken. A
      // hallucinated or jailbroken "pay" on a flagged counterparty dies in
      // code, not in the prompt.
      if (guardrail.blocked) {
        // Refused by enforceApGuardrails before the provider can be called.
      } else if (!operating) {
        status = "held";
        reasoning += " [no operating account configured]";
      } else {
        try {
          const result = await executePayment({
            sourceType: "invoice",
            sourceId: invoice.id,
            fromAccountId: operating.id,
            destination: payoutAddress(counterparty.address, counterparty.id),
            amount,
            memo: `Invoice ${invoice.id}`,
          }, { provider });
          txRef = result.txRef;
          status = result.status === "confirmed" ? "paid" : result.status === "pending" ? "matched" : "held";
          if (result.status === "failed") reasoning += ` [transfer failed: ${result.error ?? "provider reported failure"}]`;
          else if (result.status === "pending") reasoning += " [transfer submitted; awaiting provider confirmation]";
          else operatingBalance = await syncOperatingBalance(operating.id);
        } catch (err) {
          status = "held";
          reasoning += ` [execution failed: ${(err as Error).message}]`;
        }
      }
    }

    const now = new Date().toISOString();
    const update = await db
      .from("invoices")
      .update({
        status,
        agent_reasoning: reasoning,
        decided_at: now,
        settled_at: status === "paid" ? now : null,
        tx_ref: txRef,
      })
      .eq("id", invoice.id);
    if (update.error) throw new Error(update.error.message);

    await appendLedgerEntry({
      actor: "agent",
      domain: "ap",
      action: `ap_${decision.action}`,
      summary: `${decision.action.toUpperCase()} invoice from ${counterparty.name} for ${amount} USDC`,
      detail: {
        invoiceId: invoice.id,
        decision,
        decisionMode: mode,
        guardrailBlocked,
        guardrailRule: guardrail.rule,
        observed: {
          amount,
          paymentLimit: limit,
          riskLevel: counterparty.risk_level,
          poReference: invoice.po_reference,
          goodsReceived: invoice.goods_received,
          operatingBalance,
        },
        execution: { txRef, chainMode: provider.mode, resultingStatus: status, settlementRequired: true },
      },
    });

    lines.push({
      domain: "ap",
      message: `${counterparty.name}: ${decision.action} (${amount} USDC)`,
    });
  }

  // --------------------------------------------------------------- 3. contractors
  const milestones = unwrap(
    await db
      .from("milestones")
      .select("*, counterparties(id, name, risk_level, payment_limit, address)")
      .eq("verified", true)
      .eq("status", "verified")
  ) as Array<{
    id: string;
    title: string;
    amount: string;
    verification_source: string | null;
    contractor_id: string;
    counterparties: {
      id: string;
      name: string;
      risk_level: string;
      payment_limit: string | null;
      address: string | null;
    };
  }>;

  for (const milestone of milestones) {
    const contractor = milestone.counterparties;
    const amount = num(milestone.amount);
    const limit = contractor.payment_limit == null ? null : num(contractor.payment_limit);
    const highRisk = contractor.risk_level === "high";
    const overLimit = limit != null && amount > limit;

    const { value: decision, mode } = await decide<MilestoneDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to release this verified contractor milestone immediately, rather than waiting for a Net-30 cycle.",
        milestone: {
          title: milestone.title,
          amount,
          verificationSource: milestone.verification_source,
        },
        contractor: {
          name: contractor.name,
          riskLevel: contractor.risk_level,
          paymentLimit: limit,
        },
        responseShape: {
          action: "release | hold",
          reasoning: "string",
          confidence: "number between 0 and 1",
        },
      }),
      schema: milestoneDecisionSchema,
      fallback: (): MilestoneDecision => {
        if (highRisk) {
          return {
            action: "hold",
            reasoning: `${contractor.name} is flagged high risk; release blocked pending review.`,
            confidence: 0.95,
          };
        }
        return {
          action: "release",
          reasoning: `Milestone "${milestone.title}" is verified via ${milestone.verification_source}; releasing ${amount} USDC the same day instead of on Net-30 terms.`,
          confidence: 0.85,
        };
      },
    });

    let status = "held";
    let txRef: string | null = null;
    let reasoning = decision.reasoning;
    let guardrailBlocked = false;

    if (decision.action === "release") {
      if (highRisk || overLimit) {
        guardrailBlocked = true;
        reasoning += highRisk
          ? " [guardrail override: contractor is high risk — release refused]"
          : ` [guardrail override: amount exceeds the ${limit} USDC limit — release refused]`;
      } else if (operating) {
        try {
          const result = await executePayment({
            sourceType: "milestone",
            sourceId: milestone.id,
            fromAccountId: operating.id,
            destination: payoutAddress(contractor.address, contractor.id),
            amount,
            memo: `Milestone ${milestone.id}`,
          }, { provider });
          txRef = result.txRef;
          status = result.status === "confirmed" ? "paid" : result.status === "pending" ? "verified" : "held";
          if (result.status === "failed") reasoning += ` [transfer failed: ${result.error ?? "provider reported failure"}]`;
          else if (result.status === "pending") reasoning += " [transfer submitted; awaiting provider confirmation]";
          else operatingBalance = await syncOperatingBalance(operating.id);
        } catch (err) {
          reasoning += ` [execution failed: ${(err as Error).message}]`;
        }
      }
    }

    const now = new Date().toISOString();
    const update = await db
      .from("milestones")
      .update({
        status,
        agent_reasoning: reasoning,
        decided_at: now,
        settled_at: status === "paid" ? now : null,
        tx_ref: txRef,
      })
      .eq("id", milestone.id);
    if (update.error) throw new Error(update.error.message);

    await appendLedgerEntry({
      actor: "agent",
      domain: "contractor",
      action: `milestone_${decision.action}`,
      summary: `${decision.action.toUpperCase()} milestone "${milestone.title}" for ${contractor.name} (${amount} USDC)`,
      detail: {
        milestoneId: milestone.id,
        decision,
        decisionMode: mode,
        guardrailBlocked,
        observed: {
          amount,
          paymentLimit: limit,
          riskLevel: contractor.risk_level,
          verificationSource: milestone.verification_source,
        },
        execution: { txRef, chainMode: provider.mode, resultingStatus: status, settlementRequired: true },
      },
    });

    lines.push({
      domain: "contractor",
      message: `${contractor.name}: ${decision.action} "${milestone.title}"`,
    });
  }

  // ------------------------------------------------------------------ 4. treasury
  const freshAccounts = unwrap(await db.from("accounts").select("*")) as Array<{
    id: string;
    kind: string;
    balance: string;
    apy: string;
  }>;
  const operatingNow = freshAccounts.find((a) => a.kind === "operating");
  const reserveNow = freshAccounts.find((a) => a.kind === "reserve");

  const openInvoices = unwrap(
    await db
      .from("invoices")
      .select("amount, due_date, status")
      .eq("direction", "payable")
      .in("status", [...OPEN_PAYABLE_STATUSES])
  ) as Array<{ amount: string; due_date: string; status: string }>;
  const openMilestones = unwrap(
    await db.from("milestones").select("amount").in("status", ["pending", "verified"])
  ) as Array<{ amount: string }>;

  // Milestones carry no due date because a verified one is payable the same
  // day — that is the whole RFB3 argument — so every open milestone counts
  // against the near-term buffer regardless of horizon.
  const milestoneTotal = openMilestones.reduce((s, r) => s + num(r.amount), 0);
  const payableSummary = summarizePayableObligations(openInvoices);

  // The buffer the agent must not sweep below is what is actually due soon,
  // not every invoice on the books. Summing the whole payables ledger and
  // labelling it "next 7 days" — which this did until it was measured —
  // makes the agent hoard cash it could have earned yield on, and hands the
  // model a premise it has no way to check.
  const obligationsDue7d = payableSummary.due7d + milestoneTotal;
  const obligationsDue14d = payableSummary.due14d + milestoneTotal;
  const obligationsOpenTotal = payableSummary.openTotal + milestoneTotal;

  // How long swept cash could actually stay swept. An open milestone is
  // payable today, so its presence collapses the horizon to zero days.
  const daysUntilNextObligation =
    milestoneTotal > 0
      ? 0
      : payableSummary.daysUntilNext;

  if (operatingNow && reserveNow) {
    const operatingBalance = num(operatingNow.balance);
    const reserveBalance = num(reserveNow.balance);
    const apy = num(reserveNow.apy);
    const amountScale = seedScale();

    // A sweep is only worth making if it earns more than it costs, so the
    // policy is computed first and handed to the model as context. It is also
    // the fallback, which means the LLM and the heuristic reason from exactly
    // the same numbers rather than from two different pictures of the book.
    const plan = planTreasury({
      operatingBalance,
      reserveBalance,
      apy,
      obligationsDue7d,
      daysUntilNextObligation,
      roundTripCostUsd: provider.estimatedFeeUsd * 2,
    });

    const { value: decision, mode } = await decide<TreasuryDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to sweep idle operating cash into the USYC-yielding reserve, redeem from the reserve back into operating, or hold.",
        operatingBalance,
        reserveBalance,
        reserveApy: apy,
        upcomingObligationsNext7Days: obligationsDue7d,
        upcomingObligationsNext14Days: obligationsDue14d,
        totalOpenObligations: obligationsOpenTotal,
        daysUntilNextObligation: Number.isFinite(daysUntilNextObligation)
          ? Number(daysUntilNextObligation.toFixed(2))
          : null,
        economics: {
          idleAboveBuffer: plan.idle,
          requiredBuffer: plan.buffer,
          expectedHoldDays: plan.holdDays,
          projectedYieldUsd: plan.projectedYieldUsd,
          roundTripCostUsd: plan.roundTripCostUsd,
          note: "A sweep costs one transfer now and one redemption later. Sweeping is only worth doing when projectedYieldUsd exceeds roundTripCostUsd.",
        },
        responseShape: {
          action: "sweep_to_usyc | redeem_from_usyc | hold",
          amount: "number",
          reasoning: "string",
        },
      }),
      schema: treasuryDecisionSchema,
      fallback: (): TreasuryDecision => plan.decision,
    });

    let executed = false;
    let executionNote: string | null = null;

    try {
      if (decision.action === "sweep_to_usyc" && decision.amount > 0) {
        const amount = Math.min(decision.amount, operatingBalance);
        await provider.depositToEarn({ accountId: operatingNow.id, amount });
        const res = await db
          .from("accounts")
          .update({ balance: Number((reserveBalance + amount).toFixed(6)) })
          .eq("id", reserveNow.id);
        if (res.error) throw new Error(res.error.message);
        executed = true;
      } else if (decision.action === "redeem_from_usyc" && decision.amount > 0) {
        const amount = Math.min(decision.amount, reserveBalance);
        await provider.withdrawFromEarn({ accountId: operatingNow.id, amount });
        const res = await db
          .from("accounts")
          .update({ balance: Number((reserveBalance - amount).toFixed(6)) })
          .eq("id", reserveNow.id);
        if (res.error) throw new Error(res.error.message);
        executed = true;
      }
    } catch (err) {
      executionNote = `execution failed: ${(err as Error).message}`;
    }

    if (executed) {
      const res = await db.from("treasury_actions").insert({
        action: decision.action,
        amount: decision.amount,
        from_account: decision.action === "sweep_to_usyc" ? operatingNow.id : reserveNow.id,
        to_account: decision.action === "sweep_to_usyc" ? reserveNow.id : operatingNow.id,
        reasoning: decision.reasoning,
      });
      if (res.error) throw new Error(res.error.message);
    }

    await appendLedgerEntry({
      actor: "agent",
      domain: "treasury",
      action: decision.action,
      summary: `Treasury: ${decision.action} ${decision.amount} USDC`,
      detail: {
        decision,
        decisionMode: mode,
        executed,
        executionNote,
        // The USYC leg is simulated until EarnKit is wired up; recording that
        // here means the audit trail never overstates what actually happened.
        earnMode: provider.earnMode,
        observed: {
          operatingBalance,
          reserveBalance,
          obligationsDue7d,
          obligationsDue14d,
          obligationsOpenTotal,
          apy,
          amountScale,
        },
        economics: {
          idleAboveBuffer: plan.idle,
          requiredBuffer: plan.buffer,
          expectedHoldDays: plan.holdDays,
          projectedYieldUsd: plan.projectedYieldUsd,
          roundTripCostUsd: plan.roundTripCostUsd,
        },
        heuristicWouldHave: plan.decision.action,
      },
    });

    lines.push({
      domain: "treasury",
      message: `${decision.action} ${decision.amount} USDC${executionNote ? ` (${executionNote})` : ""}`,
    });
  }

  // ------------------------------------------------------------------ 5. forecast
  const receivables = unwrap(
    await db.from("invoices").select("amount").eq("direction", "receivable").in("status", ["pending", "matched"])
  ) as Array<{ amount: string }>;

  const finalAccounts = unwrap(await db.from("accounts").select("balance")) as Array<{
    balance: string;
  }>;
  const liquid = finalAccounts.reduce((s, r) => s + num(r.balance), 0);
  const projectedInflow = receivables.reduce((s, r) => s + num(r.amount), 0);

  const forecast = await db.from("forecasts").insert({
    as_of: new Date().toISOString(),
    horizon_days: 14,
    projected_inflow: projectedInflow,
    projected_outflow: obligationsDue14d,
    liquid_balance: liquid,
    recommendation:
      obligationsDue14d > liquid
        ? "Liquidity gap projected — redeem from USYC or accelerate receivables before the next cycle."
        : "Liquidity healthy.",
  });
  if (forecast.error) throw new Error(forecast.error.message);

  const finishedAt = new Date().toISOString();
  await appendLedgerEntry({
    actor: "system",
    domain: "system",
    action: "cycle_complete",
    summary: clockMode === "simulate"
      ? `Agent cycle ${day} complete: ${lines.length} decisions logged`
      : `Agent cycle complete at ${finishedAt}: ${lines.length} decisions logged`,
    detail: { day, clockMode, startedAt, finishedAt, decisionCount: lines.length, chainMode: provider.mode },
  });

  return { day, lines, mode: provider.mode, clockMode, startedAt, finishedAt };
}
