import { siteOrigin } from "../auth/env";
import { billsHref } from "../bills-view";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap, type OrgDb } from "../dal";
import { paidOnItsOwn, type PaymentStep } from "../earned-vendors";
import { emailSettingsFromEnv, sendEmail } from "../email/send";
import { BRIEF_LINES, payeeSentences, weeklyBriefEmail, type WeeklyBriefFacts } from "../email/weekly-brief";
import { readPayeeLock } from "../payee-lock";
import { appendLedgerEntry } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { cashShortOf, readOpenCashOutlook } from "../agent/cash-alert";
import { readShadowMode, type ShadowMode } from "../shadow-mode";
import { inviteHref } from "../invite-nudge";
import { listMembers, listOpenInvitations } from "../platform/members";
import { decidingRecipients, DIGEST_MAX_RECIPIENTS, DIGEST_SEND_DEADLINE_MS } from "./waiting";

/**
 * The agent's weekly brief (docs/superpowers/specs/2026-10-18-weekly-brief-design.md): on the first scheduled cycle of a
 * Monday (UTC), once per ISO week, the members who decide payments and keep its emails on are told what the agent did in
 * the last 7 days, what waits for them, what leaves in the next 7 and whether the cash covers it (W1-W3). A member can
 * also send it to themselves at once from Settings (W4). In shadow mode it speaks of the person's verdicts instead of
 * the mirror wallet's cash (W6). Runs in an organization's scope; never throws (W5).
 */

export const WEEKLY_BRIEF_SENT = "weekly_brief_sent";
/** Signed when the brief was claimed for the week and no email went: the next Monday cycle tries again (W5). */
export const WEEKLY_BRIEF_FAILED = "weekly_brief_failed";

const DAY_MS = 86_400_000;
const AGENT_DECISIONS = ["ap_pay", "ap_schedule", "ap_hold", "ap_request_info", "ap_flag_fraud", "milestone_release", "milestone_hold"];
const WAITING_STATUSES = ["held", "flagged", "awaiting_info"];
/** A member sends it to themselves at most once in this long (W4). */
export const PREVIEW_EVERY_MS = 5 * 60_000;

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The ISO week a moment falls in, "2026-W43": weeks start on Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Whether the week's brief goes now (W1): on a Monday (UTC), when it has not gone this week. */
export function briefDue(now: Date, sentThisWeek: boolean): boolean {
  return now.getUTCDay() === 1 && !sentThisWeek;
}

/** Whether there is anything to say: a quiet workspace is not emailed that nothing happened (W3). */
export function briefWorthSending(facts: WeeklyBriefFacts): boolean {
  return (
    facts.paid.count > 0 ||
    facts.received.count > 0 ||
    facts.decisions > 0 ||
    facts.waiting > 0 ||
    facts.next7.count > 0 ||
    facts.cash.short !== null ||
    (facts.shadow?.verdicts.given ?? 0) > 0 ||
    payeeSentences(facts.payees ?? null).length > 0
  );
}

/** A decision the agent held for an address (WP1): changed and unconfirmed, inside the lock's wait, or not the invoice's. */
const ADDRESS_HOLDS = ["counterparty.address_unconfirmed", "counterparty.cooling_off", "invoice.pay_to_differs"];

/**
 * Payee addresses in the last 7 days (WP1), read from the workspace's signed entries, its payee lock and its frozen payees.
 * Null when they cannot be read: the brief still goes, without them. Before migration 0137, no payee is frozen.
 */
export async function payeeWeek(orgDb: OrgDb, since: string, until: string): Promise<WeeklyBriefFacts["payees"]> {
  try {
    const [entries, holds, lock, frozen] = await Promise.all([
      orgDb
        .from("ledger_entries")
        .select("action, detail")
        .in("action", ["counterparty_address_changed", "counterparty_address_confirmed", "address_change_check_sent", "address_change_answered"])
        .gte("ts", since)
        .lt("ts", until)
        .limit(2000),
      orgDb.from("ledger_entries").select("seq").eq("actor", "agent").in("detail->>guardrailRule", ADDRESS_HOLDS).gte("ts", since).lt("ts", until).limit(2000),
      readPayeeLock(orgDb),
      orgDb.from("counterparties").select("id").not("frozen_at", "is", null).limit(1000),
    ]);
    const rows = unwrap(entries) as Array<{ action: string; detail: Record<string, unknown> }>;
    const count = (action: string, test: (detail: Record<string, unknown>) => boolean = () => true) => rows.filter((row) => row.action === action && test(row.detail)).length;
    const frozenRows = frozen.error ? [] : ((frozen.data ?? []) as unknown[]);
    return {
      lockOn: lock.on,
      // A cleared address is no change to check.
      changed: count("counterparty_address_changed", (detail) => typeof detail.to === "string"),
      confirmed: count("counterparty_address_confirmed"),
      held: (unwrap(holds) as unknown[]).length,
      asked: count("address_change_check_sent"),
      notMe: count("address_change_answered", (detail) => detail.answer === "not_me"),
      frozen: frozenRows.length,
    };
  } catch (error) {
    console.error("weekly brief: payee addresses not read", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

/** A confirmed payment of the week: what it carried, and its bill or milestone. */
type PaidRow = { amount: string | number; token: string | null; source_type?: string | null; source_id?: string | null };

/**
 * Of the week's payments in shadow mode, how many the agent made on its own for an earned vendor
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL22, AL29), which no one agreed to first: read from the
 * bills' pay decisions and a person's payments of them, or records of the transfer sent before, as the report reads them.
 */
async function paidOnItsOwnCount(orgDb: OrgDb, paid: PaidRow[]): Promise<number> {
  const bills = [...new Set(paid.flatMap((row) => (row.source_type === "invoice" && row.source_id ? [row.source_id] : [])))];
  if (bills.length === 0) return 0;
  const rows = unwrap(
    await orgDb
      .from("ledger_entries")
      .select("seq, action, invoice_id:detail->>invoiceId, earned:detail->earned, resulting_status:detail->execution->>resultingStatus, recorded:detail->recorded")
      .in("action", ["ap_pay", "approval_paid"])
      .in("detail->>invoiceId", bills)
      .limit(5000)
  ) as Array<{ seq: number | string; action: string; invoice_id: string | null; earned: unknown; resulting_status: string | null; recorded?: unknown }>;
  const stepsOf = new Map<string, PaymentStep[]>();
  for (const row of rows) {
    if (!row.invoice_id) continue;
    const step: PaymentStep = {
      seq: Number(row.seq),
      action: row.action,
      onItsOwn: row.earned !== null && typeof row.earned === "object",
      resultingStatus: row.resulting_status,
      ...(row.recorded === true ? { recorded: true } : {}),
    };
    stepsOf.set(row.invoice_id, [...(stepsOf.get(row.invoice_id) ?? []), step]);
  }
  return paid.filter((row) => row.source_type === "invoice" && row.source_id && paidOnItsOwn(stepsOf.get(row.source_id) ?? [])).length;
}

/** The brief's figures, read in the workspace's scope (W3). */
export async function weeklyBriefFacts(orgDb: OrgDb, nowMs: number, shadow: ShadowMode | null = null): Promise<WeeklyBriefFacts> {
  // The 7 whole UTC days before today, as the heading says them (review of the brief).
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const since = new Date(today - 7 * DAY_MS).toISOString();
  const until = new Date(today).toISOString();
  const [{ outlook, accounts }, paidRead, receivedRead, decisionsRead, waitingRead] = await Promise.all([
    readOpenCashOutlook(orgDb, nowMs),
    orgDb.from("payment_intents").select("amount, token, source_type, source_id").eq("status", "confirmed").gte("confirmed_at", since).lt("confirmed_at", until).limit(1000),
    // A receivable paid in full, and the rest of one paid in part (receipts), as the agent matched them.
    orgDb.from("ledger_entries").select("detail").in("action", ["ar_received", "ar_payment_applied"]).gte("ts", since).lt("ts", until).limit(1000),
    orgDb.from("ledger_entries").select("seq").eq("actor", "agent").in("action", AGENT_DECISIONS).gte("ts", since).lt("ts", until).limit(1000),
    orgDb.from("invoices").select("id").eq("direction", "payable").in("status", WAITING_STATUSES).limit(1000),
  ]);
  const paid = (unwrap(paidRead) as PaidRow[]).filter((row) => (row.token ?? "USDC") === "USDC");
  // In shadow mode, the ones the agent paid on its own for earned vendors are said apart: no one agreed to them first.
  const onItsOwn = shadow ? await paidOnItsOwnCount(orgDb, paid) : 0;
  const received = (unwrap(receivedRead) as Array<{ detail: Record<string, unknown> }>).filter((row) => (row.detail.currency ?? "USDC") === "USDC");
  const lastDay = utcDay(nowMs + 6 * DAY_MS);
  const ahead = outlook.days.filter((entry) => entry.day <= lastDay);
  const out = ahead.flatMap((entry) => entry.items.filter((item) => item.kind !== "in").map((item) => ({ day: entry.day, label: item.label, amount: item.amount, note: item.note })));
  const expected = ahead.reduce((sum, entry) => sum + entry.items.filter((item) => item.kind === "in").reduce((total, item) => total + item.amount, 0), 0);
  const short = cashShortOf(outlook);
  // In shadow mode (W6): the person's verdicts, in the week and since shadow mode began, from their signed entries.
  const verdictsOf = (rows: Array<{ ts: string; detail: Record<string, unknown> }>) => ({ given: rows.length, agreed: rows.filter((row) => row.detail.verdict === "agree").length });
  const payees = await payeeWeek(orgDb, since, until);
  const verdictRows = shadow
    ? (unwrap(await orgDb.from("ledger_entries").select("ts, detail").eq("action", "decision_verdict").gte("ts", shadow.startedAt).lt("ts", until).limit(5000)) as Array<{ ts: string; detail: Record<string, unknown> }>)
    : [];
  return {
    week: isoWeek(new Date(nowMs)),
    from: utcDay(today - 7 * DAY_MS),
    to: utcDay(today - DAY_MS),
    paid: { count: paid.length, usdc: round(paid.reduce((sum, row) => sum + Number(row.amount), 0)), ...(onItsOwn > 0 ? { onItsOwn } : {}) },
    received: { count: received.length, usdc: round(received.reduce((sum, row) => sum + Number(row.detail.amount ?? 0), 0)) },
    decisions: (unwrap(decisionsRead) as unknown[]).length,
    waiting: (unwrap(waitingRead) as unknown[]).length,
    next7: { count: out.length, usdc: round(out.reduce((sum, line) => sum + line.amount, 0)), lines: out.slice(0, BRIEF_LINES), expectedUsdc: round(expected) },
    cash: {
      operating: Number(accounts.find((account) => account.kind === "operating")?.balance ?? 0),
      reserve: Number(accounts.find((account) => account.kind === "reserve")?.balance ?? 0),
      // The wallet only mirrors the business's bills in shadow mode: its shortfall is not the business's.
      short: !shadow && short && short.need >= 0.01 ? { shortOn: short.shortOn, shortBy: short.shortBy, lowestOn: short.lowestOn, need: short.need } : null,
    },
    shadow: shadow
      ? {
          verdicts: verdictsOf(verdictRows.filter((row) => row.ts >= since)),
          sinceStart: { ...verdictsOf(verdictRows), since: shadow.startedAt.slice(0, 10) },
        }
      : null,
    payees,
  };
}

export interface BriefOutcome {
  sent: number;
  failed: number;
  /** Why nothing went, when nothing did. */
  skipped?: "not_monday" | "sent_this_week" | "no_email" | "nobody" | "quiet" | "too_soon" | "failed";
}

/**
 * Sends the week's brief (W1-W5), or, with `only`, sends it at once to that one member (W4). Signs `weekly_brief_sent`
 * once at least one email went; a preview's entry says `preview: true` and does not count as the week's. Never throws.
 */
export async function sendWeeklyBrief(options: { now?: number; only?: { userId: string; email: string } } = {}): Promise<BriefOutcome> {
  const nowMs = options.now ?? Date.now();
  const outcome: BriefOutcome = { sent: 0, failed: 0 };
  let orgId: string | undefined;
  try {
    orgId = currentOrgId();
    const scopedOrgId = orgId;
    const orgDb = db();
    const week = isoWeek(new Date(nowMs));

    if (options.only) {
      // At most once in a few minutes from Settings: their own address only, but still not a button to hold down.
      const recent = unwrap(
        await orgDb.from("ledger_entries").select("detail").eq("action", WEEKLY_BRIEF_SENT).eq("detail->>by", options.only.userId).gte("ts", new Date(nowMs - PREVIEW_EVERY_MS).toISOString()).limit(1)
      ) as Array<{ detail: Record<string, unknown> }>;
      if (recent.length > 0) return { ...outcome, skipped: "too_soon" };
    } else {
      if (new Date(nowMs).getUTCDay() !== 1) return { ...outcome, skipped: "not_monday" };
      // The week's last word, previews aside: a brief claimed for it stops a second, one that failed is tried again.
      const last = unwrap(
        await orgDb
          .from("ledger_entries")
          .select("action")
          .in("action", [WEEKLY_BRIEF_SENT, WEEKLY_BRIEF_FAILED])
          .eq("detail->>week", week)
          .or("detail->>preview.is.null,detail->>preview.neq.true")
          .order("seq", { ascending: false })
          .limit(1)
      ) as Array<{ action: string }>;
      if (!briefDue(new Date(nowMs), last[0]?.action === WEEKLY_BRIEF_SENT)) return { ...outcome, skipped: "sent_this_week" };
    }
    // In shadow mode the brief speaks of verdicts, not of the mirror wallet's cash (W6).
    const shadow = await readShadowMode(orgDb);

    const settings = emailSettingsFromEnv();
    if (!settings) return { ...outcome, skipped: "no_email" };
    // Who is told, before the figures are read: a workspace nobody is told about reads nothing more.
    const recipients = options.only ? [options.only] : (await decidingRecipients(scopedOrgId)).slice(0, DIGEST_MAX_RECIPIENTS);
    if (recipients.length === 0) return { ...outcome, skipped: "nobody" };
    const facts = await weeklyBriefFacts(orgDb, nowMs, shadow);
    if (!options.only && !briefWorthSending(facts)) return { ...outcome, skipped: "quiet" };

    const org = unwrap(await platformDb().from("orgs").select("name, slug").eq("id", scopedOrgId).single()) as { name: string; slug: string };
    const origin = siteOrigin();
    const base = `${origin}/o/${org.slug}`;
    // A workspace run by one person is asked to bring in a second (invite nudge I4). Best effort: unread, nothing is asked.
    const alone = await Promise.all([listMembers(scopedOrgId), listOpenInvitations(scopedOrgId)])
      .then(([members, invitations]) => members.length === 1 && invitations.length === 0)
      .catch(() => false);
    const email = weeklyBriefEmail({
      orgName: org.name,
      facts,
      links: {
        console: `${base}/console`,
        approvals: `${base}/approvals`,
        plan: `${base}${billsHref({ tab: "plan" })}`,
        ...(alone ? { invite: `${origin}${inviteHref(org.slug, "approver", "weekly_brief")}` } : {}),
      },
      origin,
    });

    // Claimed before the sends (review of the brief): a cycle that starts while these go, or a tick cut short after
    // them, finds the week claimed and sends nothing again. A claim that cannot be signed sends nothing.
    await appendLedgerEntry({
      actor: "system",
      domain: "system",
      action: WEEKLY_BRIEF_SENT,
      summary: options.only
        ? "Sent this week's brief to the member who asked for it"
        : `Told ${recipients.length} member(s) about the week: ${facts.paid.count} paid, ${facts.waiting} waiting, ${facts.next7.count} due in the next 7 days`,
      detail: {
        week,
        recipients: recipients.length,
        ...(options.only ? { preview: true, by: options.only.userId } : {}),
        paid: facts.paid,
        received: facts.received,
        decisions: facts.decisions,
        waiting: facts.waiting,
        next7: { count: facts.next7.count, usdc: facts.next7.usdc, expectedUsdc: facts.next7.expectedUsdc },
        short: facts.cash.short,
        ...(facts.shadow ? { shadow: facts.shadow } : {}),
        ...(facts.payees ? { payees: facts.payees } : {}),
      },
    });

    const deadline = Date.now() + DIGEST_SEND_DEADLINE_MS;
    for (const [index, recipient] of recipients.entries()) {
      if (Date.now() >= deadline) {
        outcome.failed += recipients.length - index;
        console.warn("weekly brief: send deadline passed, not sent", recipients.length - index, scopedOrgId);
        break;
      }
      const result = await sendEmail({ to: recipient.email, ...email, meter: "weekly_brief" }, settings);
      if (result.sent) outcome.sent += 1;
      else {
        outcome.failed += 1;
        console.warn("weekly brief: send failed", scopedOrgId, result.reason);
      }
    }
    if (outcome.sent === 0) {
      // Nobody got it: the claim is let go, and the next scheduled cycle that Monday tries again (W5).
      await appendLedgerEntryBestEffort(scopedOrgId, {
        actor: "system",
        domain: "system",
        action: WEEKLY_BRIEF_FAILED,
        summary: "The week's brief reached nobody; it is tried again",
        detail: { week, failed: outcome.failed, ...(options.only ? { preview: true, by: options.only.userId } : {}) },
      });
      return { ...outcome, skipped: "failed" };
    }
    return outcome;
  } catch (error) {
    console.error("weekly brief: failed", orgId ?? "no organization in scope", error instanceof Error ? error.message : String(error));
    return { ...outcome, skipped: outcome.skipped ?? "failed" };
  }
}
