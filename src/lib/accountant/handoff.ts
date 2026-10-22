import { AGENT_DECISION_ACTIONS } from "../agent/shadow-hold";
import type { OrgMembership } from "../auth/membership";
import { db, unwrap, type OrgDb } from "../dal";
import { csvCell } from "../ledger-export";
import { readWorkspaceTriage } from "./read";
import { KIND_TITLES, type TriageItem } from "./triage";

/**
 * The hand-off export (docs/superpowers/specs/2026-10-13-accountant-console-design.md A7): one workspace's month for its
 * accountant, as JSON or CSV. The decisions made in the month (the agent's on payables and a person's approvals,
 * rejections and returns, an accountant's co-signs among them, from the signed ledger as the audit export reads it), the
 * payments sent or confirmed in it,
 * the payments booked in the accounting tool, and what is open now (the console's own items).
 *
 * Read in the workspace's scope only, through its tenant client. Each amount stays with its row and its currency: no
 * total adds currencies together. The ledger head names the chain the decisions come from, so the hand-off can be
 * checked against the audit export.
 */

export const HANDOFF_FORMAT = "vestiarion-handoff/1";
const PAGE = 1000;
/** The most rows one section takes; past it the document says so. */
const MAX_ROWS = 10_000;

export interface HandoffPeriod {
  /** First day, YYYY-MM-DD. */
  from: string;
  /** The day after the last, YYYY-MM-DD. */
  to: string;
  /** "September 2026". */
  label: string;
  /** "2026-09". */
  key: string;
}

/** `?month=YYYY-MM`, or the last full month (UTC) when absent. A month that does not read, or is still to come, is null. */
export function handoffPeriod(month: string | null, now: Date = new Date()): HandoffPeriod | null {
  let year: number;
  let index: number;
  if (month === null || month === "") {
    year = now.getUTCFullYear();
    index = now.getUTCMonth() - 1;
  } else {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) return null;
    year = Number(match[1]);
    index = Number(match[2]) - 1;
    if (index < 0 || index > 11 || year < 2020) return null;
  }
  const from = new Date(Date.UTC(year, index, 1));
  if (from.getTime() > now.getTime()) return null;
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    label: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(from),
    key: from.toISOString().slice(0, 7),
  };
}

export interface HandoffDecision {
  seq: number;
  at: string;
  actor: "agent" | "human";
  action: string;
  summary: string;
  invoiceId: string | null;
  hash: string;
  /** An accountant's co-sign (`approval_given` with `cosign: true`): one of a bill's two approvals, which paid nothing. */
  cosign?: true;
}

export interface HandoffPayment {
  id: string;
  source: "invoice" | "milestone";
  sourceId: string;
  status: string;
  amount: string;
  token: string;
  destination: string;
  simulated: boolean;
  txHash: string | null;
  sentAt: string | null;
  confirmedAt: string | null;
}

export interface HandoffBooking {
  id: string;
  provider: string;
  invoiceId: string | null;
  amount: string;
  currency: string;
  paidOn: string;
  state: string;
  reference: string | null;
  account: string | null;
  confirmedAt: string | null;
}

export interface HandoffOpenItem {
  kind: string;
  title: string;
  detail: string;
  amount: string | null;
  currency: string | null;
  since: string;
  link: string;
}

export interface HandoffDoc {
  format: typeof HANDOFF_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  period: HandoffPeriod;
  /** The ledger's last entry when exported: the audit export of the same chain verifies the decisions. */
  ledgerHead: { seq: number; hash: string } | null;
  /** True when a section held more rows than one export takes. */
  cut: boolean;
  decisions: HandoffDecision[];
  payments: HandoffPayment[];
  bookings: HandoffBooking[];
  openItems: HandoffOpenItem[];
  /** The parts of the open items that could not be read. */
  unread: string[];
}

const PERSON_DECISIONS = ["approval_paid", "approval_rejected", "approval_returned"] as const;
/**
 * An approval that paid nothing yet: listed among a person's decisions only when it is an accountant's co-sign
 * (docs/superpowers/specs/2026-10-22-accountant-queue-design.md AQ6), whose `detail.cosign` is true.
 */
const APPROVAL_GIVEN = "approval_given";

async function pages<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<{ rows: T[]; cut: boolean }> {
  const rows: T[] = [];
  for (let start = 0; start < MAX_ROWS; start += PAGE) {
    const result = await read(start, start + PAGE - 1);
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    const batch = (result.data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, cut: false };
  }
  return { rows, cut: true };
}

const notSetUp = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
};

const decimal = (value: unknown) => (value === null || value === undefined ? "" : String(value));

async function decisions(orgDb: OrgDb, period: HandoffPeriod) {
  const read = await pages<{ seq: number; ts: string; actor: "agent" | "human"; action: string; summary: string; invoice_id: string | null; cosign?: string | null; hash: string }>(
    (from, to) =>
      orgDb
        .from("ledger_entries")
        .select("seq, ts, actor, action, summary, invoice_id:detail->>invoiceId, cosign:detail->>cosign, hash")
        .in("action", [...AGENT_DECISION_ACTIONS, ...PERSON_DECISIONS, APPROVAL_GIVEN])
        .gte("ts", `${period.from}T00:00:00.000Z`)
        .lt("ts", `${period.to}T00:00:00.000Z`)
        .order("seq", { ascending: true })
        .range(from, to)
  );
  return {
    cut: read.cut,
    rows: read.rows
      // The first of two approvals by an owner, admin or approver is no decision yet: the one that pays it is.
      .filter((row) => row.action !== APPROVAL_GIVEN || row.cosign === "true")
      .map((row) => ({
        seq: row.seq,
        at: row.ts,
        actor: row.actor,
        action: row.action,
        summary: row.summary,
        invoiceId: row.invoice_id ?? null,
        hash: row.hash,
        ...(row.action === APPROVAL_GIVEN ? { cosign: true as const } : {}),
      })),
  };
}

async function payments(orgDb: OrgDb, period: HandoffPeriod) {
  const from = `${period.from}T00:00:00.000Z`;
  const to = `${period.to}T00:00:00.000Z`;
  const read = await pages<{
    id: string;
    source_type: "invoice" | "milestone";
    source_id: string;
    status: string;
    amount: string | number;
    token: string | null;
    destination: string;
    provider: string | null;
    provider_mode: string | null;
    tx_hash: string | null;
    submitted_at: string | null;
    created_at: string;
    confirmed_at: string | null;
  }>((start, end) =>
    orgDb
      .from("payment_intents")
      .select("id, source_type, source_id, status, amount, token, destination, provider, provider_mode, tx_hash, submitted_at, created_at, confirmed_at")
      .or(`and(created_at.gte.${from},created_at.lt.${to}),and(confirmed_at.gte.${from},confirmed_at.lt.${to})`)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(start, end)
  );
  return {
    cut: read.cut,
    rows: read.rows.map((row) => ({
      id: row.id,
      source: row.source_type,
      sourceId: row.source_id,
      status: row.status,
      amount: decimal(row.amount),
      token: row.token ?? "USDC",
      destination: row.destination,
      simulated: !(row.provider === "circle" && row.provider_mode === "live"),
      txHash: row.tx_hash,
      sentAt: row.submitted_at ?? row.created_at,
      confirmedAt: row.confirmed_at,
    })),
  };
}

async function bookings(orgDb: OrgDb, period: HandoffPeriod) {
  try {
    const read = await pages<{
      id: string;
      provider: string;
      invoice_id: string | null;
      amount: string | number;
      currency: string;
      paid_on: string;
      state: string;
      reference: string | null;
      account: { code?: string; name?: string } | string | null;
      confirmed_at: string | null;
    }>((start, end) =>
      orgDb
        .from("accounting_postings")
        .select("id, provider, invoice_id, amount, currency, paid_on, state, reference, account, confirmed_at")
        .gte("paid_on", period.from)
        .lt("paid_on", period.to)
        .order("paid_on", { ascending: true })
        .order("id", { ascending: true })
        .range(start, end)
    );
    return {
      cut: read.cut,
      rows: read.rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        invoiceId: row.invoice_id,
        amount: decimal(row.amount),
        currency: row.currency,
        paidOn: row.paid_on,
        state: row.state,
        reference: row.reference,
        account: typeof row.account === "string" ? row.account : row.account ? [row.account.code, row.account.name].filter(Boolean).join(" ") || null : null,
        confirmedAt: row.confirmed_at,
      })),
    };
  } catch (error) {
    // Before migration 0106 nothing was booked.
    if (notSetUp(error)) return { cut: false, rows: [] };
    throw error;
  }
}

function openItem(item: TriageItem, origin: string): HandoffOpenItem {
  return {
    kind: KIND_TITLES[item.kind].one,
    title: item.title,
    detail: item.detail,
    amount: item.amount ? String(item.amount.value) : null,
    currency: item.amount?.currency ?? null,
    since: item.since,
    link: `${origin}${item.href}`,
  };
}

/** The document, read in the workspace's scope (entered by the caller, after its membership check). */
export async function buildHandoff(
  membership: OrgMembership,
  period: HandoffPeriod,
  options: { now?: Date; origin: string; orgDb?: OrgDb }
): Promise<HandoffDoc> {
  const now = options.now ?? new Date();
  const orgDb = options.orgDb ?? db();
  const [decided, paid, booked, open, head] = await Promise.all([
    decisions(orgDb, period),
    payments(orgDb, period),
    bookings(orgDb, period),
    readWorkspaceTriage(membership, now),
    orgDb.from("ledger_entries").select("seq, hash").order("seq", { ascending: false }).limit(1),
  ]);
  const headRow = (unwrap(head) as Array<{ seq: number; hash: string }>)[0] ?? null;
  return {
    format: HANDOFF_FORMAT,
    exportedAt: now.toISOString(),
    workspace: { slug: membership.slug, name: membership.name },
    period,
    ledgerHead: headRow ? { seq: headRow.seq, hash: headRow.hash } : null,
    cut: decided.cut || paid.cut || booked.cut,
    decisions: decided.rows,
    payments: paid.rows,
    bookings: booked.rows,
    openItems: open.items.map((item) => openItem(item, options.origin)),
    unread: open.unread,
  };
}

/** One table for a spreadsheet: a section column, then the columns every section shares, in order. */
export const HANDOFF_CSV_FIELDS = ["section", "id", "date", "kind", "status", "counterparty_or_title", "amount", "currency", "reference", "detail", "link"] as const;

export function* handoffCsvChunks(doc: HandoffDoc): Generator<string> {
  const row = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;
  // A BOM first, as the audit export writes, so a spreadsheet reads UTF-8 as UTF-8.
  yield `﻿${HANDOFF_CSV_FIELDS.join(",")}\r\n`;
  yield row(["workspace", doc.workspace.slug, doc.exportedAt, "hand-off", doc.cut ? "cut" : "complete", doc.workspace.name, "", "", doc.ledgerHead ? `ledger #${doc.ledgerHead.seq}` : "", `${doc.period.label}: ${doc.period.from} to ${doc.period.to} (exclusive)`, doc.ledgerHead?.hash ?? ""]);
  for (const decision of doc.decisions) {
    yield row(["decision", decision.seq, decision.at, decision.action, decision.actor, decision.summary, "", "", decision.invoiceId ?? "", decision.cosign ? "co-sign" : "", decision.hash]);
  }
  for (const payment of doc.payments) {
    yield row(["payment", payment.id, payment.confirmedAt ?? payment.sentAt ?? "", payment.source, payment.status, payment.destination, payment.amount, payment.token, payment.txHash ?? "", payment.simulated ? "simulated" : "on chain", payment.sourceId]);
  }
  for (const booking of doc.bookings) {
    yield row(["booking", booking.id, booking.paidOn, booking.provider, booking.state, booking.account ?? "", booking.amount, booking.currency, booking.reference ?? "", booking.confirmedAt ? `confirmed ${booking.confirmedAt}` : "", booking.invoiceId ?? ""]);
  }
  for (const item of doc.openItems) {
    yield row(["open_item", "", item.since, item.kind, "open", item.title, item.amount ?? "", item.currency ?? "", "", item.detail, item.link]);
  }
}

export function* handoffJsonChunks(doc: HandoffDoc): Generator<string> {
  yield JSON.stringify(doc);
}

export function handoffFileName(slug: string, period: HandoffPeriod, format: "json" | "csv"): string {
  return `vestiarion-${slug}-handoff-${period.key}.${format}`;
}

/** A brake on hand-offs, counted from the ledger's own `handoff_exported` entries, as the audit export counts its own. */
export const HANDOFF_LIMIT = { count: 10, windowMs: 10 * 60_000 };

export async function recentHandoffsBy(userId: string, now = new Date(), orgDb: OrgDb = db()): Promise<number> {
  const since = new Date(now.getTime() - HANDOFF_LIMIT.windowMs).toISOString();
  const rows = unwrap(
    await orgDb.from("ledger_entries").select("id").eq("action", "handoff_exported").gt("ts", since).eq("detail->>by", userId).limit(HANDOFF_LIMIT.count)
  ) as Array<{ id: string }>;
  return rows.length;
}
