import { cashOutlook, type CashOutlook } from "../cash-outlook";
import { outlookInputOf, type OutlookInvoice, type OutlookMilestone } from "../cash-outlook-input";
import { readAllocationRows, stillOwed } from "../allocations/book";
import { utcDay } from "../copy";
import { unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { heldForCash } from "../next-step";
import { readShadowMode } from "../shadow-mode";
import type { CycleLogLine } from "./orchestrator";

/**
 * Telling the owner before the cash runs short (docs/superpowers/specs/2026-10-17-cash-short-alert-design.md).
 *
 * The cycle's `cash_alert` stage works out the cash outlook the console and `/today` show (S1): the operating USDC and
 * the reserve, less every open USDC payable on its day and every open milestone today, over 30 days, no receivable
 * counted. When the wallet runs short, it signs one `cash_short_ahead` with how much, by when, the customers' money
 * expected by then, and what the agent is already doing about it (S2); again only when that changes (S3); and a
 * `cash_short_cleared` once it no longer runs short. The activity feed tells both in the console, Telegram and Slack
 * (S4). Code only. Not in shadow mode (S5).
 */

export const CASH_SHORT_AHEAD = "cash_short_ahead";
export const CASH_SHORT_CLEARED = "cash_short_cleared";

const DAY_MS = 86_400_000;
/** Told again after this long while it is still short (S3). */
const REMIND_AFTER_MS = 7 * DAY_MS;
/** Told again once the need grew by at least this much, and by a tenth (S3). */
const GREW_BY_USDC = 1;
const GREW_BY_SHARE = 0.1;
/**
 * Short by less than a cent is not worth a word (review of #420): it neither alerts nor clears, so a lowest balance a
 * hair either side of zero does not flip the alert on and off.
 */
const MIN_NEED_USDC = 0.01;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** The statuses of a payable still to pay, and of a receivable still owed (`OPEN_PAYABLE_STATUSES` with `pending`, `matched`). */
const OPEN_STATUSES = ["pending", "matched", "held", "awaiting_info", "scheduled"] as const;
const OPEN_INVOICE_COLUMNS = "id, direction, counterparty_id, amount, currency, status, due_date, scheduled_for, created_at, memo, po_reference, counterparties(name)";
interface OpenInvoiceRow {
  id: string;
  direction: string;
  counterparty_id: string;
  amount: string | number;
  currency: string | null;
  status: string;
  due_date: string;
  scheduled_for: string | null;
  created_at: string | null;
  memo: string | null;
  po_reference: string | null;
  counterparties: { name: string } | null;
}

/** How short the wallet runs within the outlook, from its days (S1). */
export interface CashShort {
  /** The first day it runs short, `YYYY-MM-DD`, and how short that day. */
  shortOn: string;
  shortBy: number;
  /** The day it is shortest, and how short then: what it needs to pay everything due through that day. */
  lowestOn: string;
  need: number;
  /** The receivables expected on or before `lowestOn`: never counted until they arrive. */
  expectedBy: number;
  /** Whether they would cover it, had each arrived on its day. */
  coveredWithExpected: boolean;
}

/** What the agent is doing about it (S2): null where a count could not be read. */
export interface CashShortDoing {
  heldForCash: { count: number; total: number } | null;
  termRequestsOpen: number | null;
  customerDiscountsOpen: number | null;
}

/** How short the wallet runs, from the outlook's days; null when it never does. */
export function cashShortOf(outlook: Pick<CashOutlook, "shortOn" | "days">): CashShort | null {
  if (outlook.shortOn === null) return null;
  const shortDay = outlook.days.find((day) => day.day === outlook.shortOn);
  if (!shortDay) return null;
  let lowest = shortDay;
  for (const day of outlook.days) if (day.balance < lowest.balance) lowest = day;
  const upTo = outlook.days.filter((day) => day.day <= lowest.day);
  const expectedBy = upTo.reduce((sum, day) => sum + day.items.filter((item) => item.kind === "in").reduce((total, item) => total + item.amount, 0), 0);
  return {
    shortOn: outlook.shortOn,
    shortBy: round(-shortDay.balance),
    lowestOn: lowest.day,
    need: round(-lowest.balance),
    expectedBy: round(expectedBy),
    coveredWithExpected: upTo.every((day) => day.balanceWithExpected >= 0),
  };
}

/** The last alert, as the ledger signed it. */
export interface LastAlert {
  action: string;
  ts: string;
  detail: Record<string, unknown>;
}

/**
 * Whether to tell the owner now (S3): "alert" when it runs short and was not told, or the short day came earlier, or
 * the need grew by a dollar and a tenth, or a week passed; "clear" when it no longer runs short after an alert; null
 * when nothing changed, or it is short by less than a cent.
 */
export function alertDue(now: CashShort | null, last: LastAlert | null, nowMs: number): "alert" | "clear" | null {
  const told = last?.action === CASH_SHORT_AHEAD ? last : null;
  if (now === null) return told ? "clear" : null;
  if (now.need < MIN_NEED_USDC) return null;
  if (!told) return "alert";
  const shortOn = typeof told.detail.shortOn === "string" ? told.detail.shortOn : null;
  const need = Number(told.detail.need);
  if (shortOn === null || !Number.isFinite(need)) return "alert";
  if (now.shortOn < shortOn) return "alert";
  if (now.need - need >= Math.max(GREW_BY_USDC, need * GREW_BY_SHARE)) return "alert";
  if (nowMs - Date.parse(told.ts) >= REMIND_AFTER_MS) return "alert";
  return null;
}

/** "229.97 USDC", as the alert writes amounts. */
const usdc = (value: number) => `${AMOUNT.format(value)} USDC`;

/** The alert's one-line summary, for the ledger. */
export function cashShortSummary(short: CashShort): string {
  return short.lowestOn === short.shortOn
    ? `Cash runs short on ${utcDay(short.shortOn)} by ${usdc(short.need)}`
    : `Cash runs short on ${utcDay(short.shortOn)} by ${usdc(short.shortBy)}, and by ${usdc(short.need)} on ${utcDay(short.lowestOn)}`;
}

/** The stage: work out the outlook, decide whether to tell, and sign it. */
export async function alertCashShort(orgDb: OrgDb, options: { now?: number } = {}): Promise<CycleLogLine[]> {
  const nowMs = options.now ?? Date.now();
  // Shadow mode (S5): the business pays in its own money, and the wallet only mirrors agreed payments.
  if (await readShadowMode(orgDb)) return [];
  const [accountsRead, invoicesRead, milestonesRead, lastRead] = await Promise.all([
    orgDb.from("accounts").select("kind, balance").in("kind", ["operating", "reserve"]),
    // Only what is open: the whole invoice table is more than a read returns once a workspace has paid enough bills
    // (review of #420), and a paid one moves no money ahead.
    orgDb.from("invoices").select(OPEN_INVOICE_COLUMNS).in("status", [...OPEN_STATUSES]).order("due_date", { ascending: true }),
    orgDb.from("milestones").select("id, title, amount, status, escrow_state, counterparties(name)").in("status", ["pending", "verified"]),
    orgDb.from("ledger_entries").select("action, ts, detail").in("action", [CASH_SHORT_AHEAD, CASH_SHORT_CLEARED]).order("seq", { ascending: false }).limit(1),
  ]);
  const accounts = (unwrap(accountsRead) as Array<{ kind: string; balance: string | number }>).map((row) => ({ kind: row.kind, balance: Number(row.balance) }));
  const openRows = unwrap(invoicesRead) as unknown as OpenInvoiceRow[];
  // What customers still owe on each open receivable, as the console counts it: less what was applied to it already.
  const receivableIds = openRows.filter((row) => row.direction === "receivable").map((row) => row.id);
  const applied = receivableIds.length > 0 ? ((await readAllocationRows(orgDb, { invoiceIds: receivableIds }).catch(() => null)) ?? []) : [];
  const invoices: OutlookInvoice[] = openRows.map((row) => ({
    id: row.id,
    direction: row.direction,
    counterparty_name: row.counterparties?.name ?? "unknown",
    amount: row.direction === "receivable" ? stillOwed(row, applied) : Number(row.amount),
    currency: row.currency === "EURC" ? "EURC" : "USDC",
    due_date: row.due_date,
    status: row.status,
    scheduled_for: row.scheduled_for,
  }));
  const milestones: OutlookMilestone[] = (unwrap(milestonesRead) as unknown as Array<{ id: string; title: string; amount: string | number; status: string; escrow_state: string | null; counterparties: { name: string } | null }>).map((row) => ({
    id: row.id,
    title: row.title,
    contractor_name: row.counterparties?.name ?? "unknown",
    amount: Number(row.amount),
    status: row.status,
    escrow_state: row.escrow_state as OutlookMilestone["escrow_state"],
  }));
  const short = cashShortOf(cashOutlook(outlookInputOf({ now: nowMs, accounts, invoices, milestones })));
  const last = ((unwrap(lastRead) as LastAlert[])[0] ?? null) as LastAlert | null;
  const due = alertDue(short, last, nowMs);
  if (due === null) return [];

  if (due === "clear" || short === null) {
    await appendLedgerEntry({
      actor: "agent",
      domain: "treasury",
      action: CASH_SHORT_CLEARED,
      summary: "The cash covers everything due in the next 30 days again",
      detail: { previous: last?.detail ?? null },
    });
    return [{ domain: "treasury", message: "cash covers everything due in the next 30 days again" }];
  }

  const doing = await whatTheAgentIsDoing(orgDb, invoices.filter((row) => row.direction === "payable" && row.status === "held").map((row) => ({ id: row.id, amount: row.amount, currency: row.currency ?? "USDC" })), nowMs);
  const operating = Number(accounts.find((account) => account.kind === "operating")?.balance ?? 0);
  const reserve = Number(accounts.find((account) => account.kind === "reserve")?.balance ?? 0);
  await appendLedgerEntry({
    actor: "agent",
    domain: "treasury",
    action: CASH_SHORT_AHEAD,
    summary: cashShortSummary(short),
    detail: { ...short, cash: { operating, reserve }, doing },
  });
  return [{ domain: "treasury", message: cashShortSummary(short).replace(/^Cash/, "cash") }];
}

/**
 * The bills held for want of cash, and the requests for more time and customer discounts still open (S2). Each read is
 * best effort: a table not there yet, or a read that fails, is a count not known.
 */
async function whatTheAgentIsDoing(orgDb: OrgDb, held: Array<{ id: string; amount: number; currency: string }>, nowMs: number): Promise<CashShortDoing> {
  const heldUsdc = held.filter((row) => row.currency === "USDC");
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const [decisions, requests, offers] = await Promise.all([
    heldUsdc.length > 0
      ? orgDb.from("ledger_entries").select("detail").in("action", ["ap_pay", "ap_hold"]).in("detail->>invoiceId", heldUsdc.map((row) => row.id)).order("seq", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    orgDb.from("payment_term_requests").select("id").in("status", ["open", "countered"]).limit(500),
    orgDb.from("customer_discount_offers").select("id, status, pay_by").in("status", ["open", "accepted"]).limit(500),
  ]);
  let heldForCashCount: CashShortDoing["heldForCash"] = null;
  if (!decisions.error) {
    const latest = new Map<string, Record<string, unknown>>();
    for (const entry of (decisions.data ?? []) as Array<{ detail: Record<string, unknown> }>) {
      const id = typeof entry.detail.invoiceId === "string" ? entry.detail.invoiceId : null;
      if (id && !latest.has(id)) latest.set(id, entry.detail);
    }
    const rows = heldUsdc.filter((row) => heldForCash(latest.get(row.id)));
    heldForCashCount = { count: rows.length, total: round(rows.reduce((sum, row) => sum + row.amount, 0)) };
  }
  return {
    heldForCash: heldForCashCount,
    termRequestsOpen: requests.error ? null : (requests.data ?? []).length,
    customerDiscountsOpen: offers.error
      ? null
      : ((offers.data ?? []) as Array<{ status: string; pay_by: string }>).filter((row) => row.status === "open" || String(row.pay_by).slice(0, 10) >= today).length,
  };
}
