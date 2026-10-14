import { currentOrgId } from "../context";
import { db, type OrgDb } from "../dal";
import { assertLedgerCanSign } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { amountWords, COMMISSION_ACTIONS, commissionsNotReady, formulaWords, ratePercent, units, type CommissionLine } from "./model";
import { byIds, receivableLabel, toLine, type LineDbRow } from "./read";

/**
 * Commissions recorded (docs/superpowers/specs/2026-10-14-commissions-design.md C5, C7, C12): `record_commissions`
 * (0118) inserts every accrual and adjustment not recorded yet and answers the rows it inserted, so a replay, or the
 * cycle and a person's application at the same moment, records nothing twice and signs each row once. Called by the
 * agent's cycle in its receipts stage and right after a person applies or reverses a payment. Before 0118 runs, it
 * records nothing and says nothing. Runs inside an organization scope.
 */

export interface RecordResult {
  lines: CommissionLine[];
  log: Array<{ domain: string; message: string }>;
}

const NOTHING: RecordResult = { lines: [], log: [] };

/**
 * The most rows each of `record_commissions`'s three inserts takes in one call (0118), so an answer stays under
 * PostgREST's 1,000 rows: an answer of this many or more may have left some, and is called again.
 */
export const RECORDED_PER_STATEMENT = 300;
/** How many calls one recording makes at most; the next one records the rest. */
const CALLS = 10;

export async function recordCommissions(orgDb: OrgDb = db()): Promise<RecordResult> {
  // With no key to sign them, nothing is recorded: the next call records them, signed.
  try {
    assertLedgerCanSign();
  } catch {
    return NOTHING;
  }
  const result: RecordResult = { lines: [], log: [] };
  for (let call = 0; call < CALLS; call += 1) {
    const answer = await orgDb.rpc("record_commissions", {});
    if (answer.error) {
      if (commissionsNotReady(answer.error)) return result;
      throw new Error(answer.error.message ?? "commissions not recorded");
    }
    const lines = ((answer.data ?? []) as LineDbRow[]).map(toLine);
    if (lines.length > 0) result.log.push(...(await sign(orgDb, lines)));
    result.lines.push(...lines);
    if (lines.length < RECORDED_PER_STATEMENT) break;
  }
  return result;
}

/** The names a summary gives, best effort: a failed read leaves the entry with plainer words, never unsigned. */
async function namesOf(orgDb: OrgDb, lines: readonly CommissionLine[]) {
  try {
    const [partners, receivables] = await Promise.all([
      byIds<{ id: string; name: string }>(lines.map((line) => line.beneficiaryId), (some) => orgDb.from("counterparties").select("id, name").in("id", some)),
      byIds<{ id: string; memo: string | null }>(
        lines.flatMap((line) => (line.invoiceId ? [line.invoiceId] : [])),
        (some) => orgDb.from("invoices").select("id, memo").in("id", some)
      ),
    ]);
    return { partners: new Map(partners.map((row) => [row.id, row.name])), labels: new Map(receivables.map((row) => [row.id, receivableLabel(row)])) };
  } catch (error) {
    console.error("commissions: names not read", error instanceof Error ? error.message : error);
    return { partners: new Map<string, string>(), labels: new Map<string, string>() };
  }
}

/** One signed entry for each row recorded. */
async function sign(orgDb: OrgDb, lines: readonly CommissionLine[]): Promise<RecordResult["log"]> {
  const { partners: nameOf, labels: labelOf } = await namesOf(orgDb, lines);
  const log: RecordResult["log"] = [];
  for (const line of lines) {
    const partner = nameOf.get(line.beneficiaryId) ?? "the partner";
    const label = (line.invoiceId ? labelOf.get(line.invoiceId) : undefined) ?? "an invoice";
    const formula = formulaWords(line);
    if (line.kind === "accrual") {
      const summary = `Commission of ${amountWords(line.amount, line.currency)} for ${partner} on ${label}: ${formula}, due ${line.dueAt.slice(0, 10)}`;
      await appendLedgerEntryBestEffort(currentOrgId(), {
        actor: "agent",
        domain: "ap",
        action: COMMISSION_ACTIONS.accrued,
        summary,
        detail: {
          lineId: line.id,
          planId: line.planId,
          beneficiaryId: line.beneficiaryId,
          receivableId: line.invoiceId,
          dealId: line.dealId,
          source: line.source,
          allocationId: line.allocationId,
          transferId: line.transferId,
          base: units(line.base),
          rateBps: line.rateBps,
          ratePercent: ratePercent(line.rateBps),
          basis: line.basis,
          amount: units(line.amount),
          currency: line.currency,
          appliedAt: line.appliedAt,
          dueAt: line.dueAt,
          formula,
        },
      });
      log.push({ domain: "ap", message: summary });
    } else {
      // Due when it was recorded: its accrual was in a payable already, so it lowers the next one (C7).
      const carriedForward = line.dueAt === line.appliedAt;
      const summary = `Commission of ${partner} on ${label} adjusted by −${amountWords(-line.amount, line.currency)}: ${line.reason === "whole_match_released" ? "the payment was unmatched" : "the payment was reversed"}${carriedForward ? ", carried to the next payable" : ""}`;
      await appendLedgerEntryBestEffort(currentOrgId(), {
        actor: "agent",
        domain: "ap",
        action: COMMISSION_ACTIONS.adjusted,
        summary,
        detail: {
          lineId: line.id,
          adjusts: line.adjusts,
          planId: line.planId,
          beneficiaryId: line.beneficiaryId,
          receivableId: line.invoiceId,
          dealId: line.dealId,
          source: line.source,
          reversalId: line.allocationId,
          transferId: line.transferId,
          amount: units(line.amount),
          currency: line.currency,
          appliedAt: line.appliedAt,
          dueAt: line.dueAt,
          carriedForward,
          reason: line.reason,
        },
      });
      log.push({ domain: "ap", message: summary });
    }
  }
  return log;
}

/**
 * Right after a person applies or reverses a payment (C5): best effort, so the application stands whatever happens
 * here, and the agent's next cycle records what this missed.
 */
export async function recordCommissionsAfterApplication(): Promise<void> {
  try {
    await recordCommissions();
  } catch (error) {
    console.error("commissions not recorded after an application", error instanceof Error ? error.message : "unknown error");
  }
}
