import { currentOrgId } from "../context";
import { db } from "../dal";
import { assertLedgerCanSign } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import {
  amountWords,
  COMMISSION_ACTIONS,
  CommissionError,
  commissionErrorFromDb,
  payableMemo,
  ratePercent,
  units,
  type CommissionCurrency,
  type CommissionPlan,
  type PlanDraft,
} from "./model";
import { LINE_COLUMNS, PLAN_COLUMNS, toLine, toPlan, type LineDbRow, type PlanDbRow } from "./read";

/**
 * Commission plans and payouts, written (docs/superpowers/specs/2026-10-14-commissions-design.md C2, C10-C12): a plan
 * set or changed as its next version, a plan ended, and one payable made from what a partner is due. Each goes through
 * its 0118 function, which holds the rules under a lock per partner; a refusal reads in plain words. Each is a signed
 * entry (domain `ap`), written best effort after `assertLedgerCanSign`. Every export runs inside an organization scope;
 * who may do it is the command's check.
 */

type DbError = { code?: string; message?: string; details?: string } | null;

function failed(error: NonNullable<DbError>): never {
  const known = commissionErrorFromDb(error);
  if (known) throw known;
  throw new Error(error.message ?? "the commission was not written");
}

async function partnerName(beneficiaryId: string): Promise<string> {
  const read = await db().from("counterparties").select("name").eq("id", beneficiaryId).limit(1);
  if (read.error) failed(read.error);
  const row = ((read.data ?? []) as Array<{ name: string }>)[0];
  if (!row) throw new CommissionError("no_beneficiary");
  return row.name;
}

const planDetail = (plan: CommissionPlan) => ({
  planId: plan.id,
  replaces: plan.replaces,
  beneficiaryId: plan.beneficiaryId,
  beneficiaryMember: plan.memberId,
  rateBps: plan.rateBps,
  ratePercent: ratePercent(plan.rateBps),
  basis: plan.basis,
  scope: plan.scope,
  dealIds: plan.dealIds,
  holdDays: plan.holdDays,
  reference: plan.reference,
  startedAt: plan.startedAt,
});

/** Sets a partner's plan, or changes the version in force (`replaces`), as its next version (C2). */
export async function setPlan(input: { actorId: string; draft: PlanDraft; replaces: string | null }): Promise<{ plan: CommissionPlan; partner: string }> {
  const { actorId, draft } = input;
  const partner = await partnerName(draft.beneficiaryId);
  assertLedgerCanSign();
  const answer = await db()
    .rpc("set_commission_plan", {
      p_beneficiary_id: draft.beneficiaryId,
      p_rate_bps: draft.rateBps,
      p_basis: draft.basis,
      p_scope: draft.scope,
      p_deal_ids: draft.dealIds,
      p_hold_days: draft.holdDays,
      p_reference: draft.reference,
      p_beneficiary_member: draft.memberId,
      p_replaces: input.replaces,
      p_by: actorId,
    })
    .single<PlanDbRow>();
  if (answer.error) failed(answer.error);
  const plan = toPlan(answer.data as PlanDbRow, draft.scope === "chosen_deals" ? draft.dealIds : []);
  const deals = plan.scope === "all_deals" ? "every deal" : `${plan.dealIds.length} chosen ${plan.dealIds.length === 1 ? "deal" : "deals"}`;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: COMMISSION_ACTIONS.planSet,
    summary: `${input.replaces ? "Changed" : "Set"} the commission plan of ${partner}: ${ratePercent(plan.rateBps)} ${plan.basis} of money received on ${deals}, held ${plan.holdDays} days`,
    detail: { by: actorId, beneficiaryName: partner, ...planDetail(plan) },
  });
  return { plan, partner };
}

/** Ends a plan: money applied from now on earns nothing under it (C2). */
export async function endPlan(input: { actorId: string; planId: string }): Promise<{ plan: CommissionPlan; partner: string }> {
  assertLedgerCanSign();
  const answer = await db().rpc("end_commission_plan", { p_plan_id: input.planId, p_by: input.actorId }).single<PlanDbRow>();
  if (answer.error) failed(answer.error);
  const plan = toPlan(answer.data as PlanDbRow);
  const partner = await partnerName(plan.beneficiaryId).catch(() => "the partner");
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: COMMISSION_ACTIONS.planEnded,
    summary: `Ended the commission plan of ${partner}`,
    detail: { by: input.actorId, planId: plan.id, beneficiaryId: plan.beneficiaryId, beneficiaryName: partner, endedAt: plan.endedAt },
  });
  return { plan, partner };
}

export interface PayableCreated {
  payoutId: string;
  invoiceId: string;
  statement: string;
  amount: number;
  currency: CommissionCurrency;
  partner: string;
  lineCount: number;
}

/**
 * One payable for exactly the lines the person reviewed (C10): `create_commission_payout` refuses them when they changed
 * since, add up to nothing, or the person is the partner. Then the payable's `create_invoice` entry, as every payable
 * has, with `via: "commission"`, and the `commission_payable_created` entry naming its lines.
 */
export async function createPayable(input: { actorId: string; beneficiaryId: string; currency: CommissionCurrency; lineIds: readonly string[] }): Promise<PayableCreated> {
  const { actorId, beneficiaryId, currency } = input;
  const partner = await partnerName(beneficiaryId);
  const [lineRead, planRead] = await Promise.all([
    input.lineIds.length > 0 ? db().from("commission_lines").select(LINE_COLUMNS).in("id", [...input.lineIds]) : null,
    db().from("commission_plans").select(PLAN_COLUMNS).eq("beneficiary_id", beneficiaryId).is("ended_at", null).limit(1),
  ]);
  if (lineRead?.error) failed(lineRead.error);
  if (planRead.error) failed(planRead.error);
  const lines = ((lineRead?.data ?? []) as LineDbRow[]).map(toLine);
  if (lines.length !== input.lineIds.length) throw new CommissionError("changed");
  const reference = ((planRead.data ?? []) as PlanDbRow[])[0]?.reference ?? null;
  const memo = payableMemo(lines, reference);
  assertLedgerCanSign();

  const answer = await db().rpc("create_commission_payout", {
    p_beneficiary_id: beneficiaryId,
    p_currency: currency,
    p_line_ids: [...input.lineIds],
    p_memo: memo,
    p_by: actorId,
  });
  if (answer.error) failed(answer.error);
  const made = answer.data as { payoutId: string; invoiceId: string; statement: string; amount: number | string; lineCount: number };
  const amount = Number(made.amount);
  const accrued = lines.filter((line) => line.kind === "accrual").reduce((total, line) => total + line.amount, 0);
  const adjusted = lines.filter((line) => line.kind === "adjustment").reduce((total, line) => total + line.amount, 0);
  const dueDate = new Date().toISOString().slice(0, 10);

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: "create_invoice",
    summary: `Added payable invoice for ${partner}: ${amount} ${currency}, commission statement ${made.statement}`,
    detail: {
      by: actorId,
      invoiceId: made.invoiceId,
      counterpartyId: beneficiaryId,
      counterpartyName: partner,
      amount,
      currency,
      dueDate,
      poReference: made.statement,
      goodsReceived: true,
      via: "commission",
      commission: { payoutId: made.payoutId, statement: made.statement },
    },
  });
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: COMMISSION_ACTIONS.payableCreated,
    summary: `Created a payable of ${amountWords(Math.round(amount * 1_000_000), currency)} for the commissions of ${partner} (${made.statement})`,
    detail: {
      by: actorId,
      payoutId: made.payoutId,
      statement: made.statement,
      payableId: made.invoiceId,
      beneficiaryId,
      beneficiaryName: partner,
      amount,
      currency,
      lineIds: lines.map((line) => line.id).sort(),
      accrued: units(accrued),
      adjusted: units(adjusted),
    },
  });
  return { payoutId: made.payoutId, invoiceId: made.invoiceId, statement: made.statement, amount, currency, partner, lineCount: made.lineCount };
}
