import { db, type OrgDb } from "../dal";
import { decimalOf as decimal, fxVariance, rateAtPayment, rateValue, referenceRate, roundedMoney, type FxRate, type Money } from "../money";
import { notSetUp, storedReferenceRates } from "./rates-store";

/**
 * The FX variance on each paid bill that was converted at a rate (docs/superpowers/specs/2026-10-13-currency-provenance-
 * design.md M6), recorded once per bill in `fx_variances` (0113) inside the workspace's organization scope. The rate at
 * payment is a stored reference rate, published at or before the payment and at most 36 hours before it; this module
 * never reads the feed, and a bill whose payment-day rate was not recorded has an unknown variance, never a guess.
 * Recorded by the hourly rates job, the report and Bills & receivables, whichever comes first; nothing that decides or
 * pays reads it.
 */

export interface RecordedVariance {
  invoiceId: string;
  currency: string;
  paid: Money;
  paidAt: string;
  covered: Money;
  decision: FxRate;
  payment: FxRate;
  valueAtPayment: Money;
  variance: Money;
  recordedAt: string;
}

/** A paid bill whose variance is not known: no rate was recorded within 36 hours before its payment. */
export interface UnknownVariance {
  invoiceId: string;
  currency: string;
  paidAt: string;
  reason: string;
}

export type VariancesRead = { available: false } | { available: true; recorded: RecordedVariance[]; unknown: UnknownVariance[] };

const PAGE = 1000;

type BillRow = {
  id: string;
  amount: number | string;
  paid_amount: number | string | null;
  currency: string | null;
  original_currency: string | null;
  original_amount: number | string | null;
  fx_rate: number | string | null;
  fx_source: string | null;
  fx_at: string | null;
};
type IntentRow = { source_id: string; amount: number | string; token: string | null; confirmed_at: string | null; executed_at: string | null; updated_at: string };
type VarianceRow = {
  invoice_id: string;
  currency: string;
  paid_amount: number | string;
  paid_at: string;
  covered_amount: number | string;
  decision_rate: number | string;
  decision_source: string;
  decision_at: string;
  payment_rate_id: string;
  payment_rate: number | string;
  payment_source: string;
  payment_rate_at: string;
  value_at_payment: number | string;
  variance: number | string;
  recorded_at: string;
};

const VARIANCE_COLUMNS =
  "invoice_id, currency, paid_amount, paid_at, covered_amount, decision_rate, decision_source, decision_at, payment_rate_id, payment_rate, payment_source, payment_rate_at, value_at_payment, variance, recorded_at";

const text = (value: number | string) => (typeof value === "number" ? String(value) : value);

function toRecorded(row: VarianceRow): RecordedVariance | null {
  const decision = referenceRate(row.currency, text(row.decision_rate), row.decision_source, new Date(row.decision_at).toISOString());
  const payment = referenceRate(row.currency, text(row.payment_rate), row.payment_source, new Date(row.payment_rate_at).toISOString(), row.payment_rate_id);
  if (!decision || !payment) return null;
  return {
    invoiceId: row.invoice_id,
    currency: row.currency,
    paid: roundedMoney(text(row.paid_amount), "USDC"),
    paidAt: new Date(row.paid_at).toISOString(),
    covered: roundedMoney(text(row.covered_amount), row.currency),
    decision,
    payment,
    valueAtPayment: roundedMoney(text(row.value_at_payment), "USDC"),
    variance: roundedMoney(text(row.variance), "USDC"),
    recordedAt: row.recorded_at,
  };
}

/** The variances recorded, for the bills named or every bill; `available: false` before 0113 runs. */
export async function readFxVariances(orgDb: OrgDb = db(), invoiceIds?: readonly string[]): Promise<{ available: false } | { available: true; recorded: RecordedVariance[] }> {
  const recorded: RecordedVariance[] = [];
  if (invoiceIds && invoiceIds.length === 0) return { available: true, recorded };
  for (let from = 0; ; from += PAGE) {
    let query = orgDb.from("fx_variances").select(VARIANCE_COLUMNS);
    if (invoiceIds) query = query.in("invoice_id", [...invoiceIds]);
    const result = await query.order("invoice_id", { ascending: true }).range(from, from + PAGE - 1);
    if (result.error) {
      if (notSetUp(result.error)) return { available: false };
      throw new Error(`fx_variances not read: ${result.error.message}`);
    }
    const page = (result.data ?? []) as VarianceRow[];
    recorded.push(...page.map(toRecorded).filter((row): row is RecordedVariance => row !== null));
    if (page.length < PAGE) return { available: true, recorded };
  }
}

/** Paid payables converted at a rate, from a currency other than the dollar, with their confirmed payment. */
async function paidConvertedBills(orgDb: OrgDb, invoiceIds?: readonly string[]): Promise<Array<{ bill: BillRow; intent: IntentRow }>> {
  const bills: BillRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = orgDb
      .from("invoices")
      .select("id, amount, paid_amount, currency, original_currency, original_amount, fx_rate, fx_source, fx_at")
      .eq("direction", "payable")
      .eq("status", "paid")
      .not("original_currency", "is", null)
      .neq("original_currency", "USD");
    if (invoiceIds) query = query.in("id", [...invoiceIds]);
    const result = await query.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (result.error) throw new Error(`invoices not read: ${result.error.message}`);
    const page = (result.data ?? []) as BillRow[];
    bills.push(...page);
    if (page.length < PAGE) break;
  }
  if (bills.length === 0) return [];
  const intents = new Map<string, IntentRow>();
  for (let start = 0; start < bills.length; start += 200) {
    const ids = bills.slice(start, start + 200).map((bill) => bill.id);
    const result = await orgDb
      .from("payment_intents")
      .select("source_id, amount, token, confirmed_at, executed_at, updated_at")
      .eq("source_type", "invoice")
      .eq("status", "confirmed")
      .in("source_id", ids);
    if (result.error) throw new Error(`payment_intents not read: ${result.error.message}`);
    for (const row of (result.data ?? []) as IntentRow[]) intents.set(row.source_id, row);
  }
  return bills.flatMap((bill) => {
    const intent = intents.get(bill.id);
    return intent ? [{ bill, intent }] : [];
  });
}

/**
 * Records the variance of each paid, converted bill that has none yet and whose payment-day rate was recorded, then
 * answers every variance recorded and every one still unknown. `invoiceIds` limits it to those bills.
 */
export async function recordFxVariances(orgDb: OrgDb = db(), options: { invoiceIds?: readonly string[] } = {}): Promise<VariancesRead> {
  const before = await readFxVariances(orgDb, options.invoiceIds);
  if (!before.available) return before;
  const done = new Set(before.recorded.map((row) => row.invoiceId));
  const candidates = (await paidConvertedBills(orgDb, options.invoiceIds)).filter(({ bill }) => !done.has(bill.id));
  if (candidates.length === 0) return { available: true, recorded: before.recorded, unknown: [] };

  const facts = candidates.flatMap(({ bill, intent }) => {
    const currency = (bill.original_currency ?? "").toUpperCase();
    const paidAt = new Date(intent.confirmed_at ?? intent.executed_at ?? intent.updated_at).toISOString();
    const paid = roundedMoney(text(bill.paid_amount ?? intent.amount), "USDC");
    const decision =
      bill.fx_rate != null && bill.fx_source && bill.fx_at && rateValue(text(bill.fx_rate)) !== null
        ? referenceRate(currency, text(bill.fx_rate), bill.fx_source, new Date(bill.fx_at).toISOString())
        : null;
    // Only a USDC payment of a bill with its decision rate has a variance to record.
    if ((intent.token ?? "USDC") !== "USDC" || (bill.currency ?? "USDC") !== "USDC" || !decision || paid.minor <= BigInt(0)) return [];
    return [{ invoiceId: bill.id, currency, paidAt, paid, decision }];
  });
  if (facts.length === 0) return { available: true, recorded: before.recorded, unknown: [] };

  const times = facts.map((fact) => Date.parse(fact.paidAt));
  const stored = await storedReferenceRates(
    orgDb,
    facts.map((fact) => fact.currency),
    { since: new Date(Math.min(...times) - 36 * 60 * 60_000), until: new Date(Math.max(...times)) }
  );
  const rows: Array<Record<string, unknown>> = [];
  const unknown: UnknownVariance[] = [];
  for (const fact of facts) {
    const payment = rateAtPayment(stored.filter((rate) => rate.to === fact.currency), fact.paidAt);
    const variance = payment?.id ? fxVariance({ paid: fact.paid, decision: fact.decision, payment }) : null;
    if (!payment?.id || !variance || variance.covered.minor <= BigInt(0)) {
      unknown.push({ invoiceId: fact.invoiceId, currency: fact.currency, paidAt: fact.paidAt, reason: `No ${fact.currency} rate was recorded in the 36 hours before the payment.` });
      continue;
    }
    rows.push({
      invoice_id: fact.invoiceId,
      currency: fact.currency,
      paid_currency: "USDC",
      paid_amount: decimal(variance.paid),
      paid_at: fact.paidAt,
      covered_amount: decimal(variance.covered),
      decision_rate: fact.decision.value,
      decision_source: fact.decision.source,
      decision_at: fact.decision.at,
      payment_rate_id: payment.id,
      payment_rate: payment.value,
      payment_source: payment.source,
      payment_rate_at: payment.at,
      value_at_payment: decimal(variance.valueAtPayment),
      variance: decimal(variance.variance),
    });
  }
  if (rows.length > 0) {
    const write = await orgDb.from("fx_variances").upsert(rows, { onConflict: "org_id,invoice_id", ignoreDuplicates: true });
    if (write.error) {
      if (notSetUp(write.error)) return { available: false };
      throw new Error(`fx_variances not recorded: ${write.error.message}`);
    }
  }
  const after = await readFxVariances(orgDb, options.invoiceIds);
  return after.available ? { available: true, recorded: after.recorded, unknown } : after;
}
