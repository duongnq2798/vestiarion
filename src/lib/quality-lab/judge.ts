/**
 * How the Quality Lab judges one scenario (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL4), and the shape
 * of its committed results (QL5). Pure: tests/quality-lab.test.ts hands it what a run did, counted from the provider's
 * transfers and the bill's writes, never inferred from a status.
 *
 * - Money **moves** when a transfer is sent or the bill is left scheduled; it **stops** otherwise.
 * - A scenario is **right** when money moved or stopped as expected, with the expected status, rule (or the hold's
 *   reason), and number of transfers, and it made no wrong payment.
 * - A **wrong payment** is any transfer or schedule where money should stop, any transfer whose destination or amount
 *   differs from the address on file and the bill's amount, or a second transfer for the same bill.
 */

export type QualityLabMoney = "moves" | "stops";

/** An outcome, expected or actual, as the results file keeps it: stable fields only, nothing that changes per run. */
export interface QualityLabOutcome {
  money: QualityLabMoney;
  status: string;
  rule: string | null;
  heldBecause: string | null;
  transfers: number;
}

/** What one scenario's run did, as the runner observed it. */
export interface QualityLabRun {
  /** The bill's status once every cycle ran. */
  status: string;
  /** The rule its last decision's entry records, or null. */
  rule: string | null;
  /** Why its last decision held it when no rule did (`execution.heldBecause`), or null. */
  heldBecause: string | null;
  /** Every transfer the provider took. */
  transfers: ReadonlyArray<{ to: string; amount: number }>;
  /**
   * Whether any write left the bill scheduled. A bill that began the run scheduled and was never written has no such
   * write: its final `status` says it, and the judge counts both.
   */
  scheduled: boolean;
}

export interface QualityLabVerdict {
  actual: QualityLabOutcome;
  right: boolean;
  wrongPayment: boolean;
}

export interface QualityLabResult {
  id: string;
  group: string;
  title: string;
  expected: QualityLabOutcome;
  actual: QualityLabOutcome;
  right: boolean;
  wrongPayment: boolean;
}

export interface QualityLabSummary {
  scenarios: number;
  right: number;
  wrongPayments: number;
}

export interface QualityLabResults {
  summary: QualityLabSummary;
  scenarios: QualityLabResult[];
}

/** USDC carries six decimals: amounts are equal at that precision. */
function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0000005;
}

/** Judges one run against what was expected, for a bill of `amount` to `addressOnFile` (QL4). */
export function judgeScenario(
  expected: QualityLabOutcome,
  run: QualityLabRun,
  bill: { amount: number; addressOnFile: string | null }
): QualityLabVerdict {
  const transfers = run.transfers.length;
  // A schedule some write made, even one a later cycle undid, or one left standing from before the run (QL4).
  const scheduled = run.scheduled || run.status === "scheduled";
  const actual: QualityLabOutcome = {
    money: transfers > 0 || run.status === "scheduled" ? "moves" : "stops",
    status: run.status,
    rule: run.rule,
    heldBecause: run.heldBecause,
    transfers,
  };
  const onFile = bill.addressOnFile?.toLowerCase() ?? null;
  const wrongPayment =
    (expected.money === "stops" && (transfers > 0 || scheduled)) ||
    run.transfers.some((transfer) => onFile === null || transfer.to.toLowerCase() !== onFile || !sameAmount(transfer.amount, bill.amount)) ||
    transfers > 1;
  const right =
    !wrongPayment &&
    actual.money === expected.money &&
    actual.status === expected.status &&
    actual.rule === expected.rule &&
    actual.heldBecause === expected.heldBecause &&
    actual.transfers === expected.transfers;
  return { actual, right, wrongPayment };
}

export function summarizeResults(results: ReadonlyArray<Pick<QualityLabResult, "right" | "wrongPayment">>): QualityLabSummary {
  return {
    scenarios: results.length,
    right: results.filter((result) => result.right).length,
    wrongPayments: results.filter((result) => result.wrongPayment).length,
  };
}

/** The committed results file's text (QL5): the summary, then each scenario, two-space JSON, LF, a final newline. */
export function renderResults(results: QualityLabResult[]): string {
  const document: QualityLabResults = { summary: summarizeResults(results), scenarios: results };
  return `${JSON.stringify(document, null, 2)}\n`;
}
