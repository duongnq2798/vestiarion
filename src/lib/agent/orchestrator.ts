import { z } from "zod";
import { supabase, unwrap } from "../supabase";
import { appendLedgerEntry } from "../ledger";
import { getChainProvider } from "../circle";
import { screenCounterparty } from "../compliance";
import { seedScale } from "../seed";
import { decide } from "./decide";

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
type TreasuryDecision = z.infer<typeof treasuryDecisionSchema>;

export interface CycleLogLine {
  domain: string;
  message: string;
}

export interface CycleResult {
  day: number;
  lines: CycleLogLine[];
  mode: string;
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

  const day = unwrap(await db.rpc("advance_sim_day").single<number>());

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
  const unscreened = unwrap(
    await db.from("counterparties").select("id, name").eq("risk_level", "unscreened")
  ) as Array<{ id: string; name: string }>;

  for (const counterparty of unscreened) {
    const result = await screenCounterparty(counterparty.id);
    lines.push({
      domain: "compliance",
      message: `Screened ${counterparty.name} → ${result.riskLevel}`,
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

    let status = statusForAction[decision.action];
    let txRef: string | null = null;
    let reasoning = decision.reasoning;
    let guardrailBlocked = false;

    if (decision.action === "pay") {
      // The guardrails are enforced here, after the model has spoken. A
      // hallucinated or jailbroken "pay" on a flagged counterparty dies in
      // code, not in the prompt.
      if (highRisk || overLimit) {
        guardrailBlocked = true;
        status = highRisk ? "flagged" : "held";
        reasoning += highRisk
          ? " [guardrail override: counterparty is high risk — payment refused before execution]"
          : ` [guardrail override: amount exceeds the ${limit} USDC payment limit — payment refused before execution]`;
      } else if (!operating) {
        status = "held";
        reasoning += " [no operating account configured]";
      } else {
        try {
          const result = await provider.transfer({
            fromAccountId: operating.id,
            toAddress: payoutAddress(counterparty.address, counterparty.id),
            amount,
            memo: `Invoice ${invoice.id}`,
          });
          txRef = result.txRef;
          status = result.status === "failed" ? "held" : "paid";
          if (result.status === "failed") reasoning += " [transfer reported FAILED by Circle]";
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
        observed: {
          amount,
          paymentLimit: limit,
          riskLevel: counterparty.risk_level,
          poReference: invoice.po_reference,
          goodsReceived: invoice.goods_received,
          operatingBalance,
        },
        execution: { txRef, chainMode: provider.mode, resultingStatus: status },
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
          const result = await provider.transfer({
            fromAccountId: operating.id,
            toAddress: payoutAddress(contractor.address, contractor.id),
            amount,
            memo: `Milestone ${milestone.id}`,
          });
          txRef = result.txRef;
          status = result.status === "failed" ? "held" : "paid";
          if (status === "paid") operatingBalance = await syncOperatingBalance(operating.id);
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
        execution: { txRef, chainMode: provider.mode, resultingStatus: status },
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
    await db.from("invoices").select("amount").eq("direction", "payable").in("status", ["pending", "matched"])
  ) as Array<{ amount: string }>;
  const openMilestones = unwrap(
    await db.from("milestones").select("amount").in("status", ["pending", "verified"])
  ) as Array<{ amount: string }>;

  const upcomingObligations =
    openInvoices.reduce((s, r) => s + num(r.amount), 0) +
    openMilestones.reduce((s, r) => s + num(r.amount), 0);

  if (operatingNow && reserveNow) {
    const operatingBalance = num(operatingNow.balance);
    const reserveBalance = num(reserveNow.balance);
    const apy = num(reserveNow.apy);
    const amountScale = seedScale();

    const { value: decision, mode } = await decide<TreasuryDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to sweep idle operating cash into the USYC-yielding reserve, redeem from the reserve back into operating, or hold.",
        operatingBalance,
        reserveBalance,
        reserveApy: apy,
        upcomingObligationsNext7Days: upcomingObligations,
        responseShape: {
          action: "sweep_to_usyc | redeem_from_usyc | hold",
          amount: "number",
          reasoning: "string",
        },
      }),
      schema: treasuryDecisionSchema,
      fallback: (): TreasuryDecision => {
        const buffer = upcomingObligations * 1.15;
        const idle = operatingBalance - buffer;
        if (idle > 100) {
          return {
            action: "sweep_to_usyc",
            amount: Math.floor(idle),
            reasoning: `Operating balance ${operatingBalance} USDC exceeds a 15% buffer over the ${upcomingObligations} USDC due in the next 7 days; sweeping ${Math.floor(idle)} USDC into USYC at ${(apy * 100).toFixed(2)}% APY.`,
          };
        }
        if (idle < 0 && reserveBalance > 0) {
          const need = Math.min(Math.ceil(-idle), reserveBalance);
          return {
            action: "redeem_from_usyc",
            amount: need,
            reasoning: `Operating balance falls ${Math.ceil(-idle)} USDC short of the obligation buffer; redeeming ${need} USDC from USYC ahead of the due dates.`,
          };
        }
        return {
          action: "hold",
          amount: 0,
          reasoning: `Operating balance ${operatingBalance} USDC sits within the buffer for ${upcomingObligations} USDC of near-term obligations; no treasury action needed.`,
        };
      },
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
        observed: { operatingBalance, reserveBalance, upcomingObligations, apy, amountScale },
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
    projected_outflow: upcomingObligations,
    liquid_balance: liquid,
    recommendation:
      upcomingObligations > liquid
        ? "Liquidity gap projected — redeem from USYC or accelerate receivables before the next cycle."
        : "Liquidity healthy.",
  });
  if (forecast.error) throw new Error(forecast.error.message);

  await appendLedgerEntry({
    actor: "system",
    domain: "system",
    action: "cycle_complete",
    summary: `Agent cycle ${day} complete: ${lines.length} decisions logged`,
    detail: { day, decisionCount: lines.length, chainMode: provider.mode },
  });

  return { day, lines, mode: provider.mode };
}
