/**
 * The rules of the agent's reminders to clients (docs/superpowers/specs/2026-10-03-collections-design.md R3–R5): when
 * code allows one, the written policy's schedule, and the tones code allows. Pure: the stage reads the facts, and the
 * receivable's card says the same rules in words.
 */

export type ReminderTone = "friendly" | "firm" | "final";
export const REMINDER_TONES = ["friendly", "firm", "final"] as const satisfies readonly ReminderTone[];

/** At most this many reminders per receivable. */
export const MAX_REMINDERS = 4;
/** At least this many days between two reminders. */
export const MIN_DAYS_BETWEEN = 3;
/** The first reminder comes no earlier than this many days before the due date. */
export const EARLIEST_DAYS_BEFORE_DUE = 3;
/** And none comes later than this many days after it. */
export const LATEST_DAYS_AFTER_DUE = 30;
/** The written policy's schedule, in days from the due date (R4): before it, on it, after it, and the last one. */
export const REFERENCE_STEPS = [-3, 0, 3, 10] as const;
/** The longest a wait may be before the model is asked again. */
export const MAX_WAIT_DAYS = 3;

const DAY_MS = 86_400_000;

export interface SentReminder {
  number: number;
  tone: ReminderTone;
  sentAt: string;
}

export interface ReminderFacts {
  now: number;
  dueDate: string;
  sent: readonly SentReminder[];
  /** Until when the agent chose to wait; null when it did not. */
  deferredUntil: string | null;
}

export type Allowance = { allowed: true; number: number; daysFromDue: number } | { allowed: false; reason: string };

export interface ReminderDecision {
  action: "send" | "wait";
  tone: ReminderTone;
  /** For a wait: the days before the model is asked again, 1 to 3. */
  waitDays?: number;
  reasoning: string;
}

const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

/** Days from the due date to today, in whole UTC days: negative before it, 0 on it. */
export function daysFromDue(dueDate: string, now: number): number {
  const due = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? `${dueDate}T00:00:00Z` : dueDate);
  return utcDay(now) - utcDay(due);
}

function latest(sent: readonly SentReminder[]): SentReminder | undefined {
  return [...sent].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
}

/** Whether code allows a reminder now (R3). The workspace, the receivable, the client's email and the link are the caller's. */
export function reminderAllowed(facts: ReminderFacts): Allowance {
  const days = daysFromDue(facts.dueDate, facts.now);
  if (facts.sent.some((reminder) => reminder.tone === "final")) return { allowed: false, reason: "the final reminder was sent" };
  if (facts.sent.length >= MAX_REMINDERS) return { allowed: false, reason: `all ${MAX_REMINDERS} reminders were sent` };
  if (days < -EARLIEST_DAYS_BEFORE_DUE) return { allowed: false, reason: `it is more than ${EARLIEST_DAYS_BEFORE_DUE} days before the due date` };
  if (days > LATEST_DAYS_AFTER_DUE) return { allowed: false, reason: `it is more than ${LATEST_DAYS_AFTER_DUE} days after the due date` };
  const last = latest(facts.sent);
  if (last && facts.now - Date.parse(last.sentAt) < MIN_DAYS_BETWEEN * DAY_MS) {
    return { allowed: false, reason: `a reminder went out less than ${MIN_DAYS_BETWEEN} days ago` };
  }
  if (facts.deferredUntil && Date.parse(facts.deferredUntil) > facts.now) return { allowed: false, reason: "the agent chose to wait" };
  return { allowed: true, number: facts.sent.length + 1, daysFromDue: days };
}

/** The tones code allows now (R5): friendly always; firm after the due date; final 7 days after it, with 2 reminders sent. */
export function allowedTones(daysFromDueDate: number, sentCount: number): ReminderTone[] {
  const tones: ReminderTone[] = ["friendly"];
  if (daysFromDueDate > 0) tones.push("firm");
  if (daysFromDueDate >= 7 && sentCount >= 2) tones.push("final");
  return tones;
}

/** The model's tone, or the strongest allowed when it chose a stronger one (R5). */
export function boundTone(tone: ReminderTone, daysFromDueDate: number, sentCount: number): { tone: ReminderTone; limited: boolean } {
  const allowed = allowedTones(daysFromDueDate, sentCount);
  return allowed.includes(tone) ? { tone, limited: false } : { tone: allowed[allowed.length - 1], limited: true };
}

/** A wait the model asked for, between 1 and 3 days. */
export function boundWaitDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 1;
  return Math.min(MAX_WAIT_DAYS, Math.max(1, Math.round(days)));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "3 days before the due date", "on the due date", "4 days after it". */
export function whenInWords(daysFromDueDate: number): string {
  if (daysFromDueDate === 0) return "on the due date";
  return daysFromDueDate < 0 ? `${plural(-daysFromDueDate, "day")} before the due date` : `${plural(daysFromDueDate, "day")} after the due date`;
}

/**
 * The written policy (R4): the next step whose day has come is sent now, friendly up to the due date, firm after it,
 * final for the last; otherwise it waits for that day, at most 3 days at a time.
 */
export function referenceReminder(facts: ReminderFacts, allowance: Extract<Allowance, { allowed: true }>): ReminderDecision {
  const days = allowance.daysFromDue;
  const step = REFERENCE_STEPS[Math.min(facts.sent.length, REFERENCE_STEPS.length - 1)];
  const tone: ReminderTone = days <= 0 ? "friendly" : allowance.number >= MAX_REMINDERS ? "final" : "firm";
  const sentWords = facts.sent.length === 0 ? "No reminder has gone out yet" : `${plural(facts.sent.length, "reminder")} went out before`;
  if (days >= step) {
    return {
      action: "send",
      tone,
      reasoning: `The receivable is ${days === 0 ? "due today" : days < 0 ? `due in ${plural(-days, "day")}` : `${plural(days, "day")} past its due date`}. ${sentWords}, and the written policy sends reminder ${allowance.number} ${whenInWords(step)}, ${tone === "friendly" ? "in a friendly tone" : tone === "firm" ? "in a firm tone" : "as the final one"}.`,
    };
  }
  const waitDays = boundWaitDays(step - days);
  return {
    action: "wait",
    tone,
    waitDays,
    reasoning: `${sentWords}. The written policy sends reminder ${allowance.number} ${whenInWords(step)}, which is ${plural(step - days, "day")} away, so it waits ${plural(waitDays, "day")}.`,
  };
}
