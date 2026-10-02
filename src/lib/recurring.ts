import { z } from "zod";
import { usdcAmountSchema } from "./intake-validation";

/**
 * Recurring payments (docs/superpowers/specs/2026-10-02-recurring-payables-design.md): when each
 * period of a schedule falls due, when its invoice is created, and what a person typed to set one
 * up. Pure; the cycle's `createRecurringInvoices` and the AP / AR page use it.
 */

export type RecurringUnit = "day" | "week" | "month";

export interface RecurringSchedule {
  /** The first due date, `YYYY-MM-DD`. */
  startsOn: string;
  /** The last due date, if any. */
  endsOn: string | null;
  everyCount: number;
  everyUnit: RecurringUnit;
  /** The index of the next period to create an invoice for. */
  nextPeriod: number;
}

const DAY_MS = 86_400_000;
/** At most this many periods are created for one schedule in one cycle (R3). */
export const MAX_PERIODS_PER_CYCLE = 3;

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Period `n`'s due date, counted from the first, never from the last (R2): a monthly schedule
 * anchored on the 31st falls on the last day of a shorter month and goes back to the 31st after.
 */
export function dueOn(schedule: Pick<RecurringSchedule, "startsOn" | "everyCount" | "everyUnit">, n: number): string {
  const start = parseDay(schedule.startsOn);
  if (schedule.everyUnit === "day") return formatDay(new Date(start.getTime() + n * schedule.everyCount * DAY_MS));
  if (schedule.everyUnit === "week") return formatDay(new Date(start.getTime() + n * schedule.everyCount * 7 * DAY_MS));
  const months = start.getUTCMonth() + n * schedule.everyCount;
  const year = start.getUTCFullYear() + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const day = Math.min(start.getUTCDate(), daysInMonth(year, month));
  return formatDay(new Date(Date.UTC(year, month, day)));
}

/** How long before its due date a period's invoice is created: its period less a day, at most 7 days (R3). */
export function leadDays(schedule: Pick<RecurringSchedule, "everyCount" | "everyUnit">): number {
  const periodDays = schedule.everyCount * (schedule.everyUnit === "day" ? 1 : schedule.everyUnit === "week" ? 7 : 28);
  return Math.max(0, Math.min(7, periodDays - 1));
}

/**
 * The periods to create invoices for now, oldest first: each whose due date is within its lead of
 * today and not after the last due date, at most `MAX_PERIODS_PER_CYCLE`. `ended` once the next
 * period would fall after the last due date (R3).
 */
export function periodsDue(schedule: RecurringSchedule, today: Date): { periods: Array<{ index: number; dueOn: string }>; ended: boolean } {
  const horizon = formatDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + leadDays(schedule) * DAY_MS));
  const periods: Array<{ index: number; dueOn: string }> = [];
  let index = schedule.nextPeriod;
  for (;;) {
    const due = dueOn(schedule, index);
    if (schedule.endsOn && due > schedule.endsOn) return { periods, ended: true };
    if (due > horizon || periods.length >= MAX_PERIODS_PER_CYCLE) return { periods, ended: false };
    periods.push({ index, dueOn: due });
    index += 1;
  }
}

/** "every month", "every 2 weeks", "every day". */
export function cadenceLabel(everyCount: number, everyUnit: RecurringUnit): string {
  return everyCount === 1 ? `every ${everyUnit}` : `every ${everyCount} ${everyUnit}s`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const recurringFormSchema = z
  .object({
    counterpartyId: z.string().uuid("Choose who is paid"),
    amount: usdcAmountSchema,
    currency: z.enum(["USDC", "EURC"]),
    memo: z.string().trim().min(1, "Say what it is for").max(160, "Keep what it is for to 160 characters"),
    poReference: z
      .string()
      .trim()
      .max(100, "Keep the reference to 100 characters")
      .transform((value) => value || null),
    everyCount: z.coerce.number().int("Every must be a whole number").min(1, "Every must be at least 1").max(366, "Every can be at most 366"),
    everyUnit: z.enum(["day", "week", "month"]),
    startsOn: z.string().regex(DAY, "Give the first due date"),
    endsOn: z
      .string()
      .trim()
      .refine((value) => value === "" || DAY.test(value), "Give the last due date as a date")
      .transform((value) => value || null),
    goodsReceived: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.endsOn && value.endsOn < value.startsOn) context.addIssue({ code: "custom", path: ["endsOn"], message: "The last due date cannot be before the first" });
  });

export type RecurringForm = z.infer<typeof recurringFormSchema>;

/** The Recurring payments form, as a person typed it; the first due date must be today or later. */
export function parseRecurringForm(
  raw: Record<"counterpartyId" | "amount" | "currency" | "memo" | "poReference" | "everyCount" | "everyUnit" | "startsOn" | "endsOn", string> & { goodsReceived: boolean },
  today: Date = new Date()
): { ok: true; value: RecurringForm } | { ok: false; message: string } {
  const parsed = recurringFormSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the recurring payment." };
  if (parsed.data.startsOn < formatDay(today)) return { ok: false, message: "The first due date cannot be in the past" };
  return { ok: true, value: parsed.data };
}
