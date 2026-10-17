import { siteOrigin } from "../auth/env";
import { billsHref } from "../bills-view";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap, type OrgDb } from "../dal";
import { emailSettingsFromEnv, sendEmail } from "../email/send";
import { BRIEF_LINES, weeklyBriefEmail, type WeeklyBriefFacts } from "../email/weekly-brief";
import { appendLedgerEntry } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { cashShortOf, readOpenCashOutlook } from "../agent/cash-alert";
import { readShadowMode } from "../shadow-mode";
import { decidingRecipients, DIGEST_MAX_RECIPIENTS, DIGEST_SEND_DEADLINE_MS } from "./waiting";

/**
 * The agent's weekly brief (docs/superpowers/specs/2026-10-18-weekly-brief-design.md): on the first scheduled cycle of a
 * Monday (UTC), once per ISO week, the members who decide payments and keep its emails on are told what the agent did in
 * the last 7 days, what waits for them, what leaves in the next 7 and whether the cash covers it (W1-W3). A member can
 * also send it to themselves at once from Settings (W4). Runs in an organization's scope; never throws (W5).
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
  return facts.paid.count > 0 || facts.received.count > 0 || facts.decisions > 0 || facts.waiting > 0 || facts.next7.count > 0 || facts.cash.short !== null;
}

/** The brief's figures, read in the workspace's scope (W3). */
export async function weeklyBriefFacts(orgDb: OrgDb, nowMs: number): Promise<WeeklyBriefFacts> {
  // The 7 whole UTC days before today, as the heading says them (review of the brief).
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const since = new Date(today - 7 * DAY_MS).toISOString();
  const until = new Date(today).toISOString();
  const [{ outlook, accounts }, paidRead, receivedRead, decisionsRead, waitingRead] = await Promise.all([
    readOpenCashOutlook(orgDb, nowMs),
    orgDb.from("payment_intents").select("amount, token").eq("status", "confirmed").gte("confirmed_at", since).lt("confirmed_at", until).limit(1000),
    // A receivable paid in full, and the rest of one paid in part (receipts), as the agent matched them.
    orgDb.from("ledger_entries").select("detail").in("action", ["ar_received", "ar_payment_applied"]).gte("ts", since).lt("ts", until).limit(1000),
    orgDb.from("ledger_entries").select("seq").eq("actor", "agent").in("action", AGENT_DECISIONS).gte("ts", since).lt("ts", until).limit(1000),
    orgDb.from("invoices").select("id").eq("direction", "payable").in("status", WAITING_STATUSES).limit(1000),
  ]);
  const paid = (unwrap(paidRead) as Array<{ amount: string | number; token: string | null }>).filter((row) => (row.token ?? "USDC") === "USDC");
  const received = (unwrap(receivedRead) as Array<{ detail: Record<string, unknown> }>).filter((row) => (row.detail.currency ?? "USDC") === "USDC");
  const lastDay = utcDay(nowMs + 6 * DAY_MS);
  const ahead = outlook.days.filter((entry) => entry.day <= lastDay);
  const out = ahead.flatMap((entry) => entry.items.filter((item) => item.kind !== "in").map((item) => ({ day: entry.day, label: item.label, amount: item.amount, note: item.note })));
  const expected = ahead.reduce((sum, entry) => sum + entry.items.filter((item) => item.kind === "in").reduce((total, item) => total + item.amount, 0), 0);
  const short = cashShortOf(outlook);
  return {
    week: isoWeek(new Date(nowMs)),
    from: utcDay(today - 7 * DAY_MS),
    to: utcDay(today - DAY_MS),
    paid: { count: paid.length, usdc: round(paid.reduce((sum, row) => sum + Number(row.amount), 0)) },
    received: { count: received.length, usdc: round(received.reduce((sum, row) => sum + Number(row.detail.amount ?? 0), 0)) },
    decisions: (unwrap(decisionsRead) as unknown[]).length,
    waiting: (unwrap(waitingRead) as unknown[]).length,
    next7: { count: out.length, usdc: round(out.reduce((sum, line) => sum + line.amount, 0)), lines: out.slice(0, BRIEF_LINES), expectedUsdc: round(expected) },
    cash: {
      operating: Number(accounts.find((account) => account.kind === "operating")?.balance ?? 0),
      reserve: Number(accounts.find((account) => account.kind === "reserve")?.balance ?? 0),
      short: short && short.need >= 0.01 ? { shortOn: short.shortOn, shortBy: short.shortBy, lowestOn: short.lowestOn, need: short.need } : null,
    },
  };
}

export interface BriefOutcome {
  sent: number;
  failed: number;
  /** Why nothing went, when nothing did. */
  skipped?: "not_monday" | "sent_this_week" | "shadow_mode" | "no_email" | "nobody" | "quiet" | "too_soon" | "failed";
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
    // Shadow mode (out of scope): the wallet only mirrors agreed payments, so its figures would mislead, a preview's too.
    if (await readShadowMode(orgDb)) return { ...outcome, skipped: "shadow_mode" };

    const settings = emailSettingsFromEnv();
    if (!settings) return { ...outcome, skipped: "no_email" };
    // Who is told, before the figures are read: a workspace nobody is told about reads nothing more.
    const recipients = options.only ? [options.only] : (await decidingRecipients(scopedOrgId)).slice(0, DIGEST_MAX_RECIPIENTS);
    if (recipients.length === 0) return { ...outcome, skipped: "nobody" };
    const facts = await weeklyBriefFacts(orgDb, nowMs);
    if (!options.only && !briefWorthSending(facts)) return { ...outcome, skipped: "quiet" };

    const org = unwrap(await platformDb().from("orgs").select("name, slug").eq("id", scopedOrgId).single()) as { name: string; slug: string };
    const origin = siteOrigin();
    const base = `${origin}/o/${org.slug}`;
    const email = weeklyBriefEmail({ orgName: org.name, facts, links: { console: `${base}/console`, approvals: `${base}/approvals`, plan: `${base}${billsHref({ tab: "plan" })}` }, origin });

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
