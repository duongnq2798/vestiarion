import { utcDay } from "../copy";
import { unwrap, type OrgDb } from "../dal";
import { dueDateIso } from "../intake-validation";
import { appendLedgerEntry } from "../ledger";
import { periodsDue, type RecurringUnit } from "../recurring";
import type { CycleLogLine } from "./orchestrator";

/**
 * The cycle's recurring stage (docs/superpowers/specs/2026-10-02-recurring-payables-design.md R1–R5):
 * for each active recurring payment, the invoice of each period that has come near, created once and
 * signed, for the AP stage to decide like any other. It authorises nothing leaving; it only writes
 * the book. Exported to be tested without a full cycle.
 */

interface ScheduleRow {
  id: string;
  counterparty_id: string;
  amount: string;
  currency: "USDC" | "EURC";
  memo: string;
  po_reference: string | null;
  goods_received: boolean;
  every_count: number;
  every_unit: RecurringUnit;
  starts_on: string;
  ends_on: string | null;
  next_period: number;
  created_by: string | null;
  counterparties: { name: string } | null;
}

const UNIQUE_VIOLATION = "23505";

export async function createRecurringInvoices(orgDb: OrgDb, now: Date = new Date()): Promise<CycleLogLine[]> {
  const schedules = unwrap(
    await orgDb
      .from("recurring_payables")
      .select("id, counterparty_id, amount, currency, memo, po_reference, goods_received, every_count, every_unit, starts_on, ends_on, next_period, created_by, counterparties(name)")
      .eq("status", "active")
      .order("created_at", { ascending: true })
  ) as unknown as ScheduleRow[];

  const lines: CycleLogLine[] = [];
  for (const schedule of schedules) {
    const name = schedule.counterparties?.name ?? "a counterparty";
    const { periods, ended } = periodsDue(
      { startsOn: schedule.starts_on, endsOn: schedule.ends_on, everyCount: schedule.every_count, everyUnit: schedule.every_unit, nextPeriod: schedule.next_period },
      now
    );

    let next = schedule.next_period;
    for (const period of periods) {
      const insert = await orgDb
        .from("invoices")
        .insert({
          direction: "payable",
          counterparty_id: schedule.counterparty_id,
          amount: schedule.amount,
          currency: schedule.currency,
          memo: `${schedule.memo} (${utcDay(`${period.dueOn}T00:00:00Z`)})`,
          po_reference: schedule.po_reference,
          goods_received: schedule.goods_received,
          due_date: dueDateIso(period.dueOn),
          // The schedule's maker, so the maker-checker rule holds for its invoices (R5).
          created_by: schedule.created_by,
          recurring_id: schedule.id,
          recurring_period: period.dueOn,
        })
        .select("id")
        .single<{ id: string }>();
      // An earlier, interrupted cycle already created this period: one invoice a period, by
      // construction (R1). Move past it without a second entry.
      if (insert.error && insert.error.code !== UNIQUE_VIOLATION) throw new Error(insert.error.message);

      // Compare-and-set on the period it read, so two cycles never both advance it.
      const advanced = await orgDb
        .from("recurring_payables")
        .update({ next_period: period.index + 1 })
        .eq("id", schedule.id)
        .eq("next_period", period.index);
      if (advanced.error) throw new Error(advanced.error.message);
      next = period.index + 1;
      if (insert.error) continue;

      await appendLedgerEntry({
        actor: "agent",
        domain: "ap",
        action: "recurring_invoice_created",
        summary: `Created the ${utcDay(`${period.dueOn}T00:00:00Z`)} invoice of the recurring payment to ${name}: ${Number(schedule.amount)} ${schedule.currency}`,
        detail: {
          invoiceId: insert.data.id,
          recurringId: schedule.id,
          period: period.dueOn,
          counterpartyId: schedule.counterparty_id,
          amount: Number(schedule.amount),
          currency: schedule.currency,
          goodsReceived: schedule.goods_received,
        },
      });
      lines.push({ domain: "ap", message: `${name}: created the ${utcDay(`${period.dueOn}T00:00:00Z`)} invoice of a recurring payment (${Number(schedule.amount)} ${schedule.currency})` });
    }

    if (ended) {
      const res = await orgDb.from("recurring_payables").update({ status: "ended" }).eq("id", schedule.id).eq("status", "active").eq("next_period", next);
      if (res.error) throw new Error(res.error.message);
      lines.push({ domain: "ap", message: `${name}: a recurring payment reached its last due date and ended` });
    }
  }
  return lines;
}
