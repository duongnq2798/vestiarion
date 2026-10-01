import { z } from "zod";
import { utcDay } from "../copy";
import { platformDb, unwrap, type PlatformRpc } from "../dal";

/**
 * The open numbers (docs/superpowers/specs/2026-09-30-open-numbers-design.md):
 * platform-wide usage for the public /open page and `npm run numbers`.
 *
 * Every figure comes from three database functions, the only readers that
 * cross workspaces (R2): `open_numbers(p_since)`; `open_first_payments(p_since)`
 * for the first payments and the time to them (first-payment design §3); and
 * `open_outcomes(p_since)` for how the agent's payment decisions turned out
 * (docs/superpowers/specs/2026-10-01-open-outcomes-design.md). They return
 * aggregates only, split into customers' workspaces, ours, and the total (R3);
 * this module validates the documents, merges them into one set of figures per
 * side, and keeps it for 60 seconds per period, so a busy public page cannot
 * hammer the database (R9).
 */

const figure = z.coerce.number();

const sideSchema = z.object({
  workspacesOpened: figure,
  liveWorkspaces: figure,
  people: figure,
  payments: figure,
  usdcPaid: figure,
  payees: figure,
  invoicesDecided: figure,
  milestonesReleased: figure,
  cycles: figure,
  modelDecisions: figure,
  policyDepartures: figure,
  refusedByCode: figure,
  usdcInWallets: figure,
});

/**
 * From open_first_payments (0042): the median is null when no workspace made a
 * first payment in the period, and both are null when the function could not
 * be read, so /open still shows every other figure.
 */
const firstSideSchema = z.object({
  firstPayments: figure.nullable(),
  medianMinutesToFirstPayment: figure.nullable(),
});

const NO_FIRSTS = { firstPayments: null, medianMinutesToFirstPayment: null };

const firstPaymentsSchema = z.object({
  sides: z.object({ customers: firstSideSchema, ours: firstSideSchema, total: firstSideSchema }),
});

/**
 * From open_outcomes (0049), all counts (outcomes design §3). Every one is
 * null when the function could not be read, so /open still shows the rest.
 */
const outcomeSideSchema = z.object({
  decisionsCarriedOut: figure.nullable(),
  decisionsEscalated: figure.nullable(),
  escalationsResolved: figure.nullable(),
  flagsResolved: figure.nullable(),
  flagsUpheld: figure.nullable(),
  invoicesPaidOnArc: figure.nullable(),
  invoicesPaidOnTime: figure.nullable(),
  invoicesPaidOnTimeUntouched: figure.nullable(),
  duplicatesCaught: figure.nullable(),
});

type OutcomeSide = z.infer<typeof outcomeSideSchema>;

const NO_OUTCOMES = Object.fromEntries(Object.keys(outcomeSideSchema.shape).map((key) => [key, null])) as {
  [K in keyof OutcomeSide]: null;
};

const outcomesSchema = z.object({
  sides: z.object({ customers: outcomeSideSchema, ours: outcomeSideSchema, total: outcomeSideSchema }),
});

/** Payments settled on one UTC day. A customer's amounts never appear by day, only their count (spec R6). */
const dailySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customers: figure,
  ours: figure,
  oursUsdc: figure,
});

const openNumbersSchema = z.object({
  generatedAt: z.string(),
  sides: z.object({ customers: sideSchema, ours: sideSchema, total: sideSchema }),
  daily: z.array(dailySchema),
  // `token` arrives once 0040 is applied; a payment without one is USDC.
  ourPayments: z.array(z.object({ at: z.string(), amount: figure, token: z.string().optional(), txHash: z.string(), chain: z.string().nullable() })),
});

export type SideKey = "customers" | "ours" | "total";
export type SideNumbers = z.infer<typeof sideSchema> & z.infer<typeof firstSideSchema> & OutcomeSide;
export type DailyPayments = z.infer<typeof dailySchema>;
export type OpenNumbers = Omit<z.infer<typeof openNumbersSchema>, "sides"> & { sides: Record<SideKey, SideNumbers> };
export type OurPayment = OpenNumbers["ourPayments"][number];

export interface Period {
  key: "all" | "7d" | "30d" | "since";
  /** The period's first instant; null for all time. */
  since: Date | null;
  label: string;
  /** The query string that selects this period on /open, "" for all time. */
  query: string;
  /** True when the request named a period that could not be read, so all time is shown instead (R8). */
  fallback: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EARLIEST_SINCE = Date.UTC(2026, 0, 1);
const ROLLING = { "7d": { days: 7, label: "Last 7 days" }, "30d": { days: 30, label: "Last 30 days" } } as const;

const allTime = (fallback: boolean): Period => ({ key: "all", since: null, label: "All time", query: "", fallback });

/** A calendar day `YYYY-MM-DD` that exists, as the start of that UTC day; null otherwise. */
function calendarDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : at;
}

/**
 * Reads /open's period from its query (R8): `?since=YYYY-MM-DD` from
 * 2026-01-01 through today, `?period=7d|30d` rolling from now, or all time.
 * Anything it cannot read falls back to all time, marked so the page can say so.
 */
export function parsePeriod(params: { period?: string | string[]; since?: string | string[] }, now: Date = new Date()): Period {
  const { period, since } = params;
  if (since !== undefined) {
    const day = typeof since === "string" ? calendarDay(since) : null;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (!day || day.getTime() < EARLIEST_SINCE || day.getTime() > today) return allTime(true);
    const iso = day.toISOString();
    return { key: "since", since: day, label: `Since ${utcDay(iso)}`, query: `?since=${iso.slice(0, 10)}`, fallback: false };
  }
  if (period === undefined) return allTime(false);
  if (period === "7d" || period === "30d") {
    const { days, label } = ROLLING[period];
    return { key: period, since: new Date(now.getTime() - days * DAY_MS), label, query: `?period=${period}`, fallback: false };
  }
  return allTime(true);
}

const MAX_CHART_DAYS = 90;

/**
 * The chart's days: every UTC day from the period's start (or, for all time,
 * the first day anything was paid) through today, with zeros where nothing
 * was paid, keeping the latest 90. Nothing paid at all gives an empty series.
 */
export function dailySeries(daily: DailyPayments[], period: Period, now: Date = new Date()): DailyPayments[] {
  if (daily.length === 0) return [];
  const byDay = new Map(daily.map((row) => [row.day, row]));
  const first = period.since ? period.since.toISOString().slice(0, 10) : [...byDay.keys()].sort()[0];
  const start = Date.parse(`${first}T00:00:00Z`);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const series: DailyPayments[] = [];
  for (let at = Math.max(start, end - (MAX_CHART_DAYS - 1) * DAY_MS); at <= end; at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    series.push(byDay.get(day) ?? { day, customers: 0, ours: 0, oursUsdc: 0 });
  }
  return series;
}

const MEMO_MS = 60_000;
const memo = new Map<string, { at: number; value: Promise<OpenNumbers> }>();

function memoKey(period: Period): string {
  return period.key === "since" && period.since ? `since:${period.since.toISOString()}` : period.key;
}

/**
 * Reads one function whose figures stand on their own: when it cannot be read
 * (before its migration is applied, say), every side gets `missing` and the
 * rest of /open still shows.
 */
function readSides<S>(fn: PlatformRpc, since: { p_since: string | null }, schema: z.ZodType<{ sides: Record<SideKey, S> }>, missing: S) {
  return Promise.resolve(platformDb().rpc(fn, since))
    .then((result) => schema.parse(unwrap(result)).sides)
    .catch((error: unknown): Record<SideKey, S> => {
      console.error(`open numbers: ${fn} not read`, error instanceof Error ? error.message : error);
      return { customers: missing, ours: missing, total: missing };
    });
}

async function fetchOpenNumbers(period: Period): Promise<OpenNumbers> {
  const since = { p_since: period.since ? period.since.toISOString() : null };
  const [numbers, first, outcomes] = await Promise.all([
    platformDb().rpc("open_numbers", since),
    readSides("open_first_payments", since, firstPaymentsSchema, NO_FIRSTS),
    readSides<OutcomeSide>("open_outcomes", since, outcomesSchema, NO_OUTCOMES),
  ]);
  const document = openNumbersSchema.parse(unwrap(numbers));
  const merge = (side: SideKey): SideNumbers => ({ ...document.sides[side], ...first[side], ...outcomes[side] });
  return { ...document, sides: { customers: merge("customers"), ours: merge("ours"), total: merge("total") } };
}

/** The open numbers for a period, read at most once a minute per period on this instance. */
export function readOpenNumbers(period: Period, now: number = Date.now()): Promise<OpenNumbers> {
  const key = memoKey(period);
  const held = memo.get(key);
  if (held && now - held.at <= MEMO_MS) return held.value;
  const value = fetchOpenNumbers(period);
  memo.set(key, { at: now, value });
  value.catch(() => {
    if (memo.get(key)?.value === value) memo.delete(key);
  });
  return value;
}

/** Puts a person on the team (`member` true) or takes them off; true when that changed anything. */
export async function setTeamMember(email: string, member: boolean): Promise<boolean> {
  return z.boolean().parse(unwrap(await platformDb().rpc("set_platform_team_member", { p_email: email, p_member: member })));
}

export async function listTeam(): Promise<Array<{ email: string; addedAt: string }>> {
  const rows = z
    .array(z.object({ email: z.string(), added_at: z.string() }))
    .parse(unwrap(await platformDb().rpc("platform_team_members")));
  return rows.map((row) => ({ email: row.email, addedAt: row.added_at }));
}
