import { outlookMoves, type OutlookInput } from "./cash-outlook";
import type { BasisOutflow, ClientRecord, OutflowNote, ScenarioBasis } from "./cash-scenarios";
import { dueOn, type RecurringUnit } from "./recurring";

/**
 * What the cash scenarios start from (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md C2-C4, C8), built on
 * Treasury from the rows it already loaded and handed to the browser, where `cashScenario` works out each scenario.
 *
 * - The outlook's own rules (`outlookMoves`) over 90 days: open USDC bills on their day (a scheduled one on the day it
 *   is scheduled for, an overdue or held one today), open milestones today, open USDC receivables on their due day.
 * - Each running recurring payment's periods that have no invoice yet, on their due day (one already due today): their
 *   amount and day are known, their invoice comes up to 7 days before.
 * - Each expected client's record from its received receivables, by the rule collections uses.
 * - EURC apart, with its day: paid from and into the EURC balance, never a USDC amount.
 *
 * Pure. Nothing here is read by the agent, a payment or a guardrail (C9).
 */

/** A recurring payment as `listRecurringPayables` reads it. */
export interface RecurringScheduleInput {
  id: string;
  counterpartyName: string;
  amount: number;
  currency: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
  everyCount: number;
  everyUnit: RecurringUnit;
  nextPeriod: number;
}

export interface ScenarioBasisInput extends OutlookInput {
  /** The workspace's recurring payments; null when they could not be read. */
  recurring: RecurringScheduleInput[] | null;
}

/** The longest horizon a scenario looks over. */
export const BASIS_DAYS = 90;
const DAY_MS = 86_400_000;
/** A schedule never projects more periods than this, however short its period. */
const MAX_PERIODS = 400;
const SETTLED_RECEIVABLE = new Set(["received", "paid"]);

const midnight = (at: number) => Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate());
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function scenarioBasis(input: ScenarioBasisInput): ScenarioBasis {
  const { today, moves, eurc } = outlookMoves(input, BASIS_DAYS);
  const offset = (at: number) => Math.max(0, Math.round((at - today) / DAY_MS));
  const lastDay = today + (BASIS_DAYS - 1) * DAY_MS;

  const outflows: BasisOutflow[] = [];
  const receivables: ScenarioBasis["receivables"] = [];
  for (const move of moves) {
    const { item } = move;
    if (item.kind === "in") {
      receivables.push({ id: move.id, label: item.label, amount: item.amount, day: offset(move.at), overdue: move.overdue, client: move.counterpartyId ?? null });
      continue;
    }
    const dueDay = move.dueDay ? offset(Date.parse(`${move.dueDay}T00:00:00Z`)) : undefined;
    outflows.push({
      id: move.id,
      kind: item.kind === "milestone" ? "milestone" : "bill",
      label: item.label,
      amount: item.amount,
      day: offset(move.at),
      // Only a receivable is "expected", and receivables were taken above.
      note: item.note as OutflowNote,
      foreign: move.foreign === true,
      ...(dueDay !== undefined && dueDay > offset(move.at) ? { dueDay } : {}),
    });
  }
  const eurcMoves: ScenarioBasis["eurc"] = eurc.map((move) => ({ kind: move.kind === "out" ? "bill" : "receivable", amount: move.amount, day: offset(move.at) }));

  // Periods already billed, whatever became of their invoice: one invoice a period (recurring payables R1).
  const billed = new Set(
    input.payables.filter((payable) => payable.recurring_id && payable.recurring_period).map((payable) => `${payable.recurring_id}:${String(payable.recurring_period).slice(0, 10)}`)
  );
  for (const schedule of input.recurring ?? []) {
    if (schedule.status !== "active") continue;
    for (let period = schedule.nextPeriod; period < schedule.nextPeriod + MAX_PERIODS; period += 1) {
      const due = dueOn(schedule, period);
      if (schedule.endsOn && due > schedule.endsOn) break;
      const at = midnight(Date.parse(`${due}T00:00:00Z`));
      if (at > lastDay) break;
      const id = `${schedule.id}:${due}`;
      if (billed.has(id)) continue;
      if ((schedule.currency ?? "USDC") !== "USDC") {
        eurcMoves.push({ kind: "bill", amount: schedule.amount, day: offset(at) });
        continue;
      }
      outflows.push({ id, kind: "recurring", label: schedule.counterpartyName, amount: schedule.amount, day: offset(at), note: "recurring, not billed yet", foreign: false });
    }
  }

  // How each expected client paid before: on time when it arrived on or before its due day (UTC), late otherwise.
  const expected = new Set(receivables.map((receivable) => receivable.client).filter((client): client is string => Boolean(client)));
  const lateDays = new Map<string, number[]>();
  const onTime = new Map<string, number>();
  for (const row of input.receivables) {
    const client = row.counterparty_id;
    if (!client || !expected.has(client) || !SETTLED_RECEIVABLE.has(row.status) || !row.settled_at) continue;
    const days = Math.floor(Date.parse(row.settled_at) / DAY_MS) - Math.floor(Date.parse(row.due_date) / DAY_MS);
    if (!Number.isFinite(days)) continue;
    if (days <= 0) onTime.set(client, (onTime.get(client) ?? 0) + 1);
    else lateDays.set(client, [...(lateDays.get(client) ?? []), days]);
  }
  const clients: Record<string, ClientRecord> = {};
  for (const client of new Set([...onTime.keys(), ...lateDays.keys()])) {
    const late = lateDays.get(client) ?? [];
    clients[client] = {
      paidOnTime: onTime.get(client) ?? 0,
      paidLate: late.length,
      averageDaysLate: late.length > 0 ? Number((late.reduce((sum, days) => sum + days, 0) / late.length).toFixed(1)) : null,
    };
  }

  return {
    today: new Date(today).toISOString().slice(0, 10),
    cash: round(input.operatingUsdc),
    reserve: round(input.reserveUsdc ?? 0),
    outflows,
    receivables,
    clients,
    eurc: eurcMoves,
    recurringRead: input.recurring !== null,
  };
}
