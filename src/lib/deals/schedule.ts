import { dealDigits, formatMinor, MAX_TOTAL_MINOR } from "./money";

/**
 * A deal's schedule (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D4-D6): the lines a template gives, in
 * minor units, adding up to the total exactly. Each line takes the floor of its exact share, worked out in `BigInt`; the
 * last takes what is left and says how much of it is rounding. Each line is due the deal's payment terms after its
 * invoice day. Browser-safe and pure: the form builds the schedule as the person types, and the server builds it again
 * before anything is written.
 */

export const DEAL_TEMPLATES = ["deposit", "milestones", "retainer", "custom"] as const;
export type DealTemplate = (typeof DEAL_TEMPLATES)[number];

export const MAX_LINES = 60;
export const MAX_MILESTONES = 24;
export const MAX_MONTHS = 60;
export const MAX_TERMS_DAYS = 365;
export const DEFAULT_TERMS_DAYS = 14;
export const LABEL_MAX = 80;
/** No line is invoiced more than ten years after the deal starts. */
const MAX_YEARS = 10;

export type TemplateInput =
  | { kind: "deposit"; depositPct: string; deliveryOn: string }
  | { kind: "milestones"; milestones: Array<{ label?: string; invoiceOn: string }> }
  | { kind: "retainer"; months: number; dayOfMonth: number }
  | { kind: "custom"; lines: Array<{ label: string; invoiceOn: string; amountMinor: number }> };

export interface ScheduleInput {
  totalMinor: number;
  currency: string;
  /** The day the deal starts: no line is invoiced before it. `YYYY-MM-DD`. */
  startsOn: string;
  termsDays: number;
  template: TemplateInput;
}

export interface ScheduleLine {
  position: number;
  kind: "charge";
  label: string;
  /** The day the line is invoiced: released by a person, or by the agent when the deal says so. */
  invoiceOn: string;
  /** The receivable's due date: the invoice day plus the payment terms. */
  dueOn: string;
  amountMinor: number;
  /** How much of the amount is the rounding remainder: on the last line of a split, 0 elsewhere. */
  roundingMinor: number;
}

export type ScheduleProblemCode =
  | "total"
  | "starts_on"
  | "terms"
  | "deposit_pct"
  | "delivery_on"
  | "milestone_count"
  | "months"
  | "day_of_month"
  | "line_count"
  | "line_label"
  | "line_date"
  | "line_amount"
  | "too_small"
  | "sum";

export type ScheduleProblem = { ok: false; code: ScheduleProblemCode; message: string };
export type ScheduleResult = { ok: true; lines: ScheduleLine[] } | ScheduleProblem;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A real `YYYY-MM-DD` day: not Feb 30. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

/** The day `days` after `day` (before, when negative). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const dayOf = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month)))).toISOString().slice(0, 10);

/**
 * `months` invoice days on `dayOfMonth`, the first on or after `startsOn`; a day past a month's end is that month's last
 * day (31 is Feb 28, or 29 in a leap year, and Apr 30).
 */
export function monthlyDates(startsOn: string, months: number, dayOfMonth: number): string[] {
  const start = new Date(`${startsOn}T00:00:00.000Z`);
  const year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  if (dayOf(year, month, dayOfMonth) < startsOn) month += 1;
  const dates: string[] = [];
  for (let index = 0; index < months; index += 1) {
    const at = new Date(Date.UTC(year, month + index, 1));
    dates.push(dayOf(at.getUTCFullYear(), at.getUTCMonth(), dayOfMonth));
  }
  return dates;
}

/**
 * Shares of `totalMinor` by weights (in any unit), each the floor of its exact share; the last takes the remainder.
 * Returns each share and the rounding the last carries.
 */
export function splitByWeights(totalMinor: number, weights: number[]): { shares: number[]; rounding: number } {
  const total = BigInt(totalMinor);
  const sum = weights.reduce((acc, weight) => acc + BigInt(weight), BigInt(0));
  const floors = weights.map((weight) => (total * BigInt(weight)) / sum);
  const given = floors.slice(0, -1).reduce((acc, share) => acc + share, BigInt(0));
  const last = total - given;
  const rounding = last - floors[floors.length - 1];
  return { shares: [...floors.slice(0, -1), last].map(Number), rounding: Number(rounding) };
}

/** A percent with at most two decimals, strictly between 0 and 100, in hundredths of a percent; null otherwise. */
export function percentBasisPoints(typed: string): number | null {
  const text = typed.trim().replace(/%$/, "").trim();
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bp > 0 && bp < 10_000 ? bp : null;
}

const percentWords = (bp: number) => `${bp / 100}%`;

function fail(code: ScheduleProblemCode, message: string): ScheduleProblem {
  return { ok: false, code, message };
}

/** The money words a refusal uses: `1,000.00 USDC`. */
export function moneyWords(minor: number, currency: string): string {
  return `${formatMinor(minor, dealDigits(currency))} ${currency}`;
}

const latestDay = (startsOn: string) => `${Number(startsOn.slice(0, 4)) + MAX_YEARS}${startsOn.slice(4)}`;

export interface LineToCheck {
  label: string;
  invoiceOn: string;
  amountMinor: number;
  kind?: "charge" | "credit";
}

/**
 * Lines a person gave, as a custom schedule or a new version takes them: at most `MAX_LINES`, each named, on a real day
 * from the start to ten years after it, a charge above zero or a credit below, and all of them adding up to the total.
 * Null when they hold; the problem otherwise.
 */
export function checkLines(lines: LineToCheck[], deal: { totalMinor: number; currency: string; startsOn: string }): ScheduleProblem | null {
  if (lines.length === 0 || lines.length > MAX_LINES) return fail("line_count", `A schedule has 1 to ${MAX_LINES} lines.`);
  const last = latestDay(deal.startsOn);
  for (const line of lines) {
    const label = line.label.trim();
    if (label.length === 0 || label.length > LABEL_MAX) return fail("line_label", `Name every line, in at most ${LABEL_MAX} characters.`);
    if (!isDay(line.invoiceOn) || line.invoiceOn < deal.startsOn || line.invoiceOn > last) {
      return fail("line_date", "Give every line an invoice day on or after the start date, and within ten years of it.");
    }
    const credit = line.kind === "credit";
    if (!Number.isSafeInteger(line.amountMinor) || (credit ? line.amountMinor >= 0 : line.amountMinor <= 0) || Math.abs(line.amountMinor) > MAX_TOTAL_MINOR) {
      return fail("line_amount", "Give every line an amount above zero.");
    }
  }
  const sum = lines.reduce((acc, line) => acc + line.amountMinor, 0);
  if (sum !== deal.totalMinor) {
    const gap = Math.abs(deal.totalMinor - sum);
    return fail(
      "sum",
      `The lines add up to ${moneyWords(sum, deal.currency)}; the deal is ${moneyWords(deal.totalMinor, deal.currency)}: ${moneyWords(gap, deal.currency)} ${sum < deal.totalMinor ? "short" : "over"}.`
    );
  }
  return null;
}

/** The lines a template gives, or why it gives none. */
export function buildSchedule(input: ScheduleInput): ScheduleResult {
  const { totalMinor, currency, startsOn, termsDays, template } = input;
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || totalMinor > MAX_TOTAL_MINOR) return fail("total", "Give the deal's total, above zero.");
  if (!isDay(startsOn)) return fail("starts_on", "Give the day the deal starts.");
  if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > MAX_TERMS_DAYS) return fail("terms", `Payment terms are 0 to ${MAX_TERMS_DAYS} days.`);

  const due = (invoiceOn: string) => addDays(invoiceOn, termsDays);
  const shaped = (parts: Array<{ label: string; invoiceOn: string; amountMinor: number }>, rounding: number): ScheduleResult => {
    const problem = checkLines(parts, { totalMinor, currency, startsOn });
    if (problem) return problem;
    return {
      ok: true,
      lines: parts.map((part, index) => ({
        position: index + 1,
        kind: "charge",
        label: part.label.trim(),
        invoiceOn: part.invoiceOn,
        dueOn: due(part.invoiceOn),
        amountMinor: part.amountMinor,
        roundingMinor: index === parts.length - 1 ? rounding : 0,
      })),
    };
  };
  const tooSmall = (shares: number[]) => shares.some((share) => share <= 0);

  switch (template.kind) {
    case "deposit": {
      const bp = percentBasisPoints(template.depositPct);
      if (bp === null) return fail("deposit_pct", "Give the deposit as a percent above 0 and below 100, with at most two decimals.");
      if (!isDay(template.deliveryOn) || template.deliveryOn < startsOn) return fail("delivery_on", "Give the delivery date, on or after the start date.");
      const { shares, rounding } = splitByWeights(totalMinor, [bp, 10_000 - bp]);
      if (tooSmall(shares)) return fail("too_small", "The total is too small to split this way.");
      return shaped(
        [
          { label: `Deposit (${percentWords(bp)})`, invoiceOn: startsOn, amountMinor: shares[0] },
          { label: "Balance on delivery", invoiceOn: template.deliveryOn, amountMinor: shares[1] },
        ],
        rounding
      );
    }
    case "milestones": {
      const count = template.milestones.length;
      if (count < 2 || count > MAX_MILESTONES) return fail("milestone_count", `Split the deal into 2 to ${MAX_MILESTONES} milestones.`);
      const { shares, rounding } = splitByWeights(totalMinor, template.milestones.map(() => 1));
      if (tooSmall(shares)) return fail("too_small", "The total is too small to split this way.");
      return shaped(
        template.milestones.map((milestone, index) => ({
          label: milestone.label?.trim() || `Milestone ${index + 1} of ${count}`,
          invoiceOn: milestone.invoiceOn,
          amountMinor: shares[index],
        })),
        rounding
      );
    }
    case "retainer": {
      if (!Number.isInteger(template.months) || template.months < 1 || template.months > MAX_MONTHS) return fail("months", `A retainer runs 1 to ${MAX_MONTHS} months.`);
      if (!Number.isInteger(template.dayOfMonth) || template.dayOfMonth < 1 || template.dayOfMonth > 31) return fail("day_of_month", "Choose a day of the month from 1 to 31.");
      const dates = monthlyDates(startsOn, template.months, template.dayOfMonth);
      const { shares, rounding } = splitByWeights(totalMinor, dates.map(() => 1));
      if (tooSmall(shares)) return fail("too_small", "The total is too small to split this way.");
      return shaped(
        dates.map((invoiceOn, index) => ({ label: `${MONTHS[Number(invoiceOn.slice(5, 7)) - 1]} ${invoiceOn.slice(0, 4)}`, invoiceOn, amountMinor: shares[index] })),
        rounding
      );
    }
    case "custom":
      return shaped(template.lines, 0);
  }
}

/**
 * The rounding each posted line carries: the built line's, where the posted line at the same place is the one the
 * template built (its name, day and amount); 0 where the person changed it.
 */
export function carryRounding(posted: Array<{ label: string; invoiceOn: string; amountMinor: number }>, built: ScheduleLine[]): number[] {
  return posted.map((line, index) => {
    const same = built[index];
    return same && same.label === line.label.trim() && same.invoiceOn === line.invoiceOn && same.amountMinor === line.amountMinor ? same.roundingMinor : 0;
  });
}
