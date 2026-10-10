import { ActualPaymentError, readMatchBills, recordActual, type ActualInput } from "../actual-payments";
import { matchActualsCsv, parseActualsCsv } from "../actual-payments-csv";
import { billDigits } from "../bill-amount";
import { plural, utcDay } from "../copy";
import { db } from "../dal";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Recording what the business paid outside Vestiarion (docs/superpowers/specs/2026-10-10-actual-payments-design.md A4,
 * A6): one bill from the report's comparison, or a CSV of them. Both are records, so they take `records.write`, as
 * adding an invoice does, and run from the console only.
 */

const amountWords = (amount: number, currency: string) =>
  `${amount.toLocaleString("en-US", { minimumFractionDigits: billDigits(currency), maximumFractionDigits: billDigits(currency) })} ${currency}`;

export async function recordActualPayment(
  actor: Actor,
  input: ActualInput & { today?: string }
): Promise<CommandOutcome<{ actualId: string; corrected: boolean }>> {
  const refusal = gate(actor, "payable.record_actual");
  if (refusal) return refusal;
  try {
    const { record, corrected } = await recordActual({ ...input, actorId: actor.userId, source: "form" });
    const verb = corrected ? "Corrected" : "Recorded";
    const said =
      record.outcome === "paid" && record.amount !== null && record.currency && record.paidOn
        ? `${verb}: your business paid ${amountWords(record.amount, record.currency)} on ${utcDay(`${record.paidOn}T00:00:00Z`)}.`
        : `${verb}: your business did not pay it.`;
    return done(said, { actualId: record.id, corrected });
  } catch (error) {
    if (error instanceof ActualPaymentError) return refused(error.code, error.message);
    console.error("recording an actual payment failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export interface NotSavedRow {
  line: number;
  invoice: string;
  why: string;
}

export async function importActualPayments(
  actor: Actor,
  input: { csv: string; today?: string }
): Promise<CommandOutcome<{ saved: number; corrected: number; same: number; notSaved: NotSavedRow[] }>> {
  const refusal = gate(actor, "payable.import_actuals");
  if (refusal) return refusal;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  let rows: ReturnType<typeof parseActualsCsv>;
  try {
    rows = parseActualsCsv(input.csv);
  } catch (error) {
    return refused("csv", error instanceof Error ? error.message : "The CSV could not be read.");
  }

  let preview: ReturnType<typeof matchActualsCsv>;
  try {
    // Matched again here, against the payables as they are now: what is saved is what a fresh preview would say.
    preview = matchActualsCsv(rows, await readMatchBills(db()), today);
  } catch (error) {
    if (error instanceof ActualPaymentError) return refused(error.code, error.message);
    console.error("reading payables for a payments CSV failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }

  let saved = 0;
  let corrected = 0;
  let same = 0;
  const notSaved: NotSavedRow[] = [];
  for (const row of preview) {
    if (row.status === "unmatched" || row.status === "invalid") {
      notSaved.push({ line: row.line, invoice: row.invoice, why: row.why });
      continue;
    }
    if (row.status === "same") {
      same += 1;
      continue;
    }
    try {
      // One record and one signed entry per row, each a correction of the bill's newest record when it has one.
      const result = await recordActual({
        actorId: actor.userId,
        source: "csv",
        today,
        invoiceId: row.invoiceId,
        outcome: "paid",
        paidOn: row.record.paidOn,
        amount: String(row.record.amount),
        currency: row.record.currency,
        method: row.record.method,
        reference: row.record.reference ?? undefined,
        replaces: row.replaces,
      });
      saved += 1;
      if (result.corrected) corrected += 1;
    } catch (error) {
      if (!(error instanceof ActualPaymentError)) {
        console.error("saving a payments CSV row failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
      }
      notSaved.push({ line: row.line, invoice: row.invoiceId, why: error instanceof ActualPaymentError ? error.message : TRY_AGAIN });
    }
  }

  const sameWords = same > 0 ? ` ${same} ${plural(same, "row was", "rows were")} the same as recorded.` : "";
  const notSavedWords = notSaved.length > 0 ? ` ${notSaved.length} ${plural(notSaved.length, "row was", "rows were")} not saved.` : "";
  if (saved === 0) {
    if (notSaved.length === 0) return done(`Nothing to save:${sameWords}`, { saved, corrected, same, notSaved });
    return refused("nothing_saved", `No payment was saved.${sameWords}${notSavedWords}`);
  }
  const fresh = saved - corrected;
  const split = [fresh > 0 ? `${fresh} new` : "", corrected > 0 ? `${corrected} ${plural(corrected, "correction", "corrections")}` : ""].filter(Boolean).join(", ");
  return done(`Saved ${saved} ${plural(saved, "payment", "payments")}: ${split}.${sameWords}${notSavedWords}`, { saved, corrected, same, notSaved });
}
