import { z } from "zod";
import { utcDay } from "../copy";
import { platformDb, unwrap } from "../dal";
import type { Network } from "../network";
import { publicRead } from "./public-cache";

/**
 * The open numbers (docs/superpowers/specs/2026-09-30-open-numbers-design.md):
 * platform-wide usage for the public /open page and `npm run numbers`.
 *
 * Every figure comes from three database functions, the only readers that
 * cross workspaces (R2): `open_numbers(p_since, p_network)`;
 * `open_first_payments(p_since, p_network)` for the first payments and the time
 * to them (first-payment design §3); and `open_outcomes(p_since, p_network)` for
 * how the agent's payment decisions turned out
 * (docs/superpowers/specs/2026-10-01-open-outcomes-design.md). Each counts one
 * network, so Arc mainnet is never added to Arc testnet (network foundation N7).
 * They return aggregates only, split into customers' workspaces, ours, and the
 * total (R3); this module validates the documents and merges them into one set
 * of figures per side. Each document is kept a minute per period and network in
 * the shared cache (public-cache.ts), so a busy public page cannot hammer the
 * database (R9) and a visitor seldom waits on a cold connection. The landing
 * shows no outcome and reads without `open_outcomes`, the costliest of them.
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

/**
 * From open_verdicts (0086): in shadow mode, the verdicts people gave on the agent's decisions and how many agreed
 * (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S8). Both null when it could not be read, so /open still
 * shows the rest.
 */
const verdictSideSchema = z.object({
  verdictsGiven: figure.nullable(),
  verdictsAgreed: figure.nullable(),
});

type VerdictSide = z.infer<typeof verdictSideSchema>;

const NO_VERDICTS: VerdictSide = { verdictsGiven: null, verdictsAgreed: null };

const verdictsSchema = z.object({
  sides: z.object({ customers: verdictSideSchema, ours: verdictSideSchema, total: verdictSideSchema }),
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
export type SideNumbers = z.infer<typeof sideSchema> & z.infer<typeof firstSideSchema> & OutcomeSide & VerdictSide;
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

export interface ReadOptions {
  /** False to leave out open_outcomes, whose figures are then all null as when it cannot be read. True by default. */
  outcomes?: boolean;
}

/** The four functions /open reads. */
type OpenRpc = "open_numbers" | "open_first_payments" | "open_outcomes" | "open_verdicts";

/**
 * A period as the shared cache keys it: all time, a rolling period by name, or a dated one by its first instant. A
 * rolling period's start is worked out when its document is read, so the entry is the same on every request.
 */
function periodName(period: Period): string {
  return period.key === "since" && period.since ? `since:${period.since.toISOString()}` : period.key;
}

function startOf(name: string, now: number): string | null {
  if (name.startsWith("since:")) return name.slice("since:".length);
  if (name === "7d" || name === "30d") return new Date(now - ROLLING[name].days * DAY_MS).toISOString();
  return null;
}

/**
 * One function's document for a period and network, from the shared cache, as the database answered it: it is checked
 * on every read, never before it is kept. An error throws, so a document that could not be read is never kept.
 */
const readDocument = publicRead("open-numbers", async (fn: OpenRpc, name: string, network: Network): Promise<unknown> =>
  unwrap(await platformDb().rpc(fn, { p_since: startOf(name, Date.now()), p_network: network })),
);

/**
 * Reads one function whose figures stand on their own: when it cannot be read
 * (before its migration is applied, say), every side gets `missing` and the
 * rest of /open still shows.
 */
function readSides<S>(fn: OpenRpc, name: string, network: Network, schema: z.ZodType<{ sides: Record<SideKey, S> }>, missing: S) {
  return readDocument(fn, name, network)
    .then((document) => schema.parse(document).sides)
    .catch((error: unknown): Record<SideKey, S> => {
      console.error(`open numbers: ${fn} not read`, error instanceof Error ? error.message : error);
      return { customers: missing, ours: missing, total: missing };
    });
}

/**
 * One network's open numbers for a period. Each function's document comes from the shared cache on its own, so one
 * that cannot be read is read again on the next request while the others are answered from the cache.
 */
export async function readOpenNumbers(period: Period, network: Network = "arc-testnet", { outcomes = true }: ReadOptions = {}): Promise<OpenNumbers> {
  const name = periodName(period);
  const [numbers, first, outcomeSides, verdicts] = await Promise.all([
    readDocument("open_numbers", name, network),
    readSides("open_first_payments", name, network, firstPaymentsSchema, NO_FIRSTS),
    outcomes
      ? readSides<OutcomeSide>("open_outcomes", name, network, outcomesSchema, NO_OUTCOMES)
      : { customers: NO_OUTCOMES, ours: NO_OUTCOMES, total: NO_OUTCOMES },
    readSides<VerdictSide>("open_verdicts", name, network, verdictsSchema, NO_VERDICTS),
  ]);
  const document = openNumbersSchema.parse(numbers);
  const merge = (side: SideKey): SideNumbers => ({ ...document.sides[side], ...first[side], ...outcomeSides[side], ...verdicts[side] });
  return { ...document, sides: { customers: merge("customers"), ours: merge("ours"), total: merge("total") } };
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

/**
 * One network's all-time open numbers for the landing (docs/superpowers/specs/2026-10-08-landing-proof-design.md P3),
 * or null when they could not be read: the database's message is logged, and the landing shows the other network.
 */
export async function readAllTimeOrNull(network: Network, options: ReadOptions = {}): Promise<OpenNumbers | null> {
  try {
    return await readOpenNumbers(parsePeriod({}), network, options);
  } catch (error) {
    console.error(`landing: ${network} open numbers not read`, error instanceof Error ? error.message : error);
    return null;
  }
}
