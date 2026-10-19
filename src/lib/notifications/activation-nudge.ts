import { createHash } from "node:crypto";
import {
  ACTIVATION_NUDGE_FAILED,
  ACTIVATION_NUDGE_SENT,
  dueNudges,
  NUDGE_MAX_RECIPIENTS,
  NUDGE_STAGES,
  NUDGE_WINDOW_MS,
  NUDGES_PER_TICK,
  nudgeOpen,
  nudgeWent,
  wholeDays,
  type DueNudge,
  type NudgeStage,
} from "../activation-nudge";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { firstBillNudgeEmail, firstVerdictNudgeEmail } from "../email/activation-nudge";
import { emailSettingsFromEnv, IDEMPOTENCY_KEY_USED, sendEmail } from "../email/send";
import { readWorkspaces } from "../growth/read";
import { appendLedgerEntry } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { networkOf } from "../network";
import { readShadowMode } from "../shadow-mode";
import { readShadowSummary } from "../verdicts";
import { decidingRecipients, DIGEST_SEND_DEADLINE_MS } from "./waiting";

/**
 * Setup reminders for workspaces that stopped (docs/superpowers/specs/2026-10-19-activation-nudge-design.md): the
 * agent tick's pass over the customer workspaces opened in the last 30 days (A5), and the one reminder for one
 * workspace, sent in its scope, claimed before it goes (A6). Neither throws.
 */

export interface NudgeOutcome {
  sent: number;
  failed: number;
  /** Why nothing went, when nothing did. */
  skipped?: "sent_before" | "gave_up" | "not_due" | "no_email" | "nobody" | "failed";
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Resend's idempotency key for one member's reminder: two ticks at once send it once (A6). No address in it. */
export function nudgeKey(orgId: string, stage: NudgeStage, userId: string): string {
  return sha256(["activation_nudge", orgId, stage, userId].join("\n"));
}

/** The real bills of the workspace in scope, as `growth_workspaces` counts them: payables of counterparties not sample. */
async function realBillCount(): Promise<number> {
  const [invoices, samples] = await Promise.all([
    db().from("invoices").select("counterparty_id").eq("direction", "payable").limit(1000),
    db().from("counterparties").select("id").eq("sample", true).limit(1000),
  ]);
  const sample = new Set((unwrap(samples) as Array<{ id: string }>).map((row) => row.id));
  return (unwrap(invoices) as Array<{ counterparty_id: string }>).filter((row) => !sample.has(row.counterparty_id)).length;
}

/**
 * Sends one workspace's reminder for `due.stage`, in that workspace's scope (A1-A4, A6): skipped when it went already,
 * failed too often, or is no longer due. Signs `activation_nudge_sent` before the emails go, and
 * `activation_nudge_failed` when none went.
 */
export async function sendActivationNudge(due: DueNudge, options: { now?: number } = {}): Promise<NudgeOutcome> {
  const nowMs = options.now ?? Date.now();
  const outcome: NudgeOutcome = { sent: 0, failed: 0 };
  let orgId: string | undefined;
  try {
    orgId = currentOrgId();
    const scopedOrgId = orgId;
    const orgDb = db();
    const earlier = unwrap(
      await orgDb
        .from("ledger_entries")
        .select("action")
        .in("action", [ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED])
        .eq("detail->>stage", due.stage)
        .order("seq", { ascending: true })
        .limit(100)
    ) as Array<{ action: string }>;
    const actions = earlier.map((row) => row.action);
    if (!nudgeOpen(actions)) return { ...outcome, skipped: nudgeWent(actions) ? "sent_before" : "gave_up" };

    const settings = emailSettingsFromEnv();
    if (!settings) return { ...outcome, skipped: "no_email" };

    // The facts again, in the workspace itself: a bill added or a verdict given since the pass read them ends it.
    const org = unwrap(
      await platformDb().from("orgs").select("name, slug, mode, network, wallet_host, api_key_iv:circle_api_key_enc->>iv").eq("id", scopedOrgId).single()
    ) as { name: string; slug: string; mode: string; network: string | null; wallet_host: string | null; api_key_iv: string | null };
    const origin = siteOrigin();
    const base = `${origin}/o/${org.slug}`;
    let email: { subject: string; html: string; text: string };
    let figures: Record<string, unknown>;
    if (due.stage === "first_bill") {
      if ((await realBillCount()) > 0) return { ...outcome, skipped: "not_due" };
      const shadow = await readShadowMode(orgDb);
      // Sample data only loads into a sandbox that simulates its payments (sample data S1), and only once.
      const simulated = org.mode === "sandbox" && networkOf(org.network) !== "arc-mainnet" && org.wallet_host === null && org.api_key_iv === null;
      const hasSample = simulated
        ? (unwrap(await orgDb.from("counterparties").select("id").eq("sample", true).limit(1)) as unknown[]).length > 0
        : true;
      const days = wholeDays(Date.parse(due.createdAt), nowMs);
      email = firstBillNudgeEmail({
        orgName: org.name,
        days,
        shadow: shadow !== null,
        offerSample: simulated && !hasSample,
        links: { addBill: `${base}/invoices?new=bill`, console: `${base}/console` },
        origin,
      });
      figures = { days, shadow: shadow !== null };
    } else {
      const shadow = await readShadowMode(orgDb);
      if (!shadow || !due.firstDecisionAt) return { ...outcome, skipped: "not_due" };
      const summary = await readShadowSummary(orgDb, shadow);
      if (summary.agreed + summary.disagreed > 0 || summary.waiting === 0) return { ...outcome, skipped: "not_due" };
      email = firstVerdictNudgeEmail({ orgName: org.name, waiting: summary.waiting, since: due.firstDecisionAt, links: { bills: `${base}/invoices` }, origin });
      figures = { waiting: summary.waiting };
    }

    const recipients = (await decidingRecipients(scopedOrgId)).slice(0, NUDGE_MAX_RECIPIENTS);
    if (recipients.length === 0) return { ...outcome, skipped: "nobody" };

    // Claimed before the sends: a tick that starts while these go finds it claimed. A claim not signed sends nothing.
    await appendLedgerEntry({
      actor: "system",
      domain: "system",
      action: ACTIVATION_NUDGE_SENT,
      summary:
        due.stage === "first_bill"
          ? `Reminded ${recipients.length} member(s) that the agent has no bill yet`
          : `Reminded ${recipients.length} member(s) that ${String(figures.waiting)} decision(s) wait for a verdict`,
      detail: { stage: due.stage, recipients: recipients.length, ...figures },
    });

    const deadline = Date.now() + DIGEST_SEND_DEADLINE_MS;
    for (const [index, recipient] of recipients.entries()) {
      if (Date.now() >= deadline) {
        outcome.failed += recipients.length - index;
        console.warn("activation nudge: send deadline passed, not sent", recipients.length - index, scopedOrgId);
        break;
      }
      const result = await sendEmail(
        { to: recipient.email, ...email, meter: "activation_nudge", idempotencyKey: nudgeKey(scopedOrgId, due.stage, recipient.userId) },
        settings
      );
      // Taken under its key already: another tick sent this member's email, so it went.
      if (result.sent || result.reason === IDEMPOTENCY_KEY_USED) outcome.sent += 1;
      else {
        outcome.failed += 1;
        console.warn("activation nudge: send failed", scopedOrgId, result.reason);
      }
    }
    if (outcome.sent === 0) {
      // Nobody got it: the claim is let go, and a later tick tries again, up to NUDGE_MAX_FAILURES times.
      await appendLedgerEntryBestEffort(scopedOrgId, {
        actor: "system",
        domain: "system",
        action: ACTIVATION_NUDGE_FAILED,
        summary: "A setup reminder reached nobody; it is tried again",
        detail: { stage: due.stage, failed: outcome.failed },
      });
      return { ...outcome, skipped: "failed" };
    }
    return outcome;
  } catch (error) {
    console.error("activation nudge: failed", orgId ?? "no organization in scope", error instanceof Error ? error.message : String(error));
    return { ...outcome, skipped: outcome.skipped ?? "failed" };
  }
}

export interface NudgePassResult {
  /** Workspaces with a reminder due. */
  due: number;
  /** Workspaces at least one member of which got it. */
  reminded: number;
  emails: number;
  skipped: Record<string, number>;
  /** Due workspaces left to the next tick: past `startBy`, or over `NUDGES_PER_TICK`. */
  left: number;
}

/**
 * The tick's pass (A5): reads `growth_workspaces` for the last 30 days once, picks the reminders due, and sends each in
 * its workspace's scope, one workspace after another, at most `NUDGES_PER_TICK`, none started after `startBy`.
 * Never throws.
 */
export async function runActivationNudges(options: { now?: number; startBy?: number; clock?: () => number } = {}): Promise<NudgePassResult> {
  const nowMs = options.now ?? Date.now();
  const clock = options.clock ?? Date.now;
  const result: NudgePassResult = { due: 0, reminded: 0, emails: 0, skipped: {}, left: 0 };
  try {
    if (!emailSettingsFromEnv()) return result;
    const workspaces = await readWorkspaces(new Date(nowMs - NUDGE_WINDOW_MS));
    if (!workspaces) return result;
    const due = dueNudges(workspaces, nowMs);
    result.due = due.length;
    const taken = due.slice(0, NUDGES_PER_TICK);
    result.left = due.length - taken.length;
    for (const [index, nudge] of taken.entries()) {
      if (options.startBy !== undefined && clock() > options.startBy) {
        result.left += taken.length - index;
        console.warn("activation nudges left to the next tick: out of time", taken.length - index);
        break;
      }
      const outcome = await withOrg(nudge.orgId, () => sendActivationNudge(nudge, { now: nowMs })).catch((error: unknown) => {
        console.error("activation nudge: workspace not entered", nudge.slug, error instanceof Error ? error.message : String(error));
        return { sent: 0, failed: 0, skipped: "failed" } as NudgeOutcome;
      });
      result.emails += outcome.sent;
      if (outcome.sent > 0) result.reminded += 1;
      else if (outcome.skipped) result.skipped[outcome.skipped] = (result.skipped[outcome.skipped] ?? 0) + 1;
    }
    return result;
  } catch (error) {
    console.error("activation nudges: failed", error instanceof Error ? error.message : String(error));
    return result;
  }
}

/** A reminder that went, as `/admin/growth` counts it (A7). */
export interface SentNudge {
  orgId: string;
  stage: NudgeStage;
  /** When its claim was signed. */
  at: string;
  /** Someone gave a verdict after it (what a first-verdict reminder asked for). */
  verdictAfter: boolean;
}

/** At most this many workspaces' ledgers are read for the tile. */
export const NUDGE_READ_LIMIT = 100;

/**
 * The reminders that went in these workspaces (A7), read from each one's ledger in its scope: a claim still standing
 * (not let go by a failure) counts. Best effort: a workspace that cannot be read counts as not reminded.
 */
export async function readSentNudges(orgIds: readonly string[]): Promise<SentNudge[]> {
  const found = await Promise.all(
    orgIds.slice(0, NUDGE_READ_LIMIT).map((orgId) =>
      withOrg(orgId, async () => {
        const rows = unwrap(
          await db()
            .from("ledger_entries")
            .select("action, ts, detail")
            .in("action", [ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED])
            .order("seq", { ascending: true })
            .limit(100)
        ) as Array<{ action: string; ts: string; detail: Record<string, unknown> }>;
        const sent: SentNudge[] = [];
        for (const stage of NUDGE_STAGES) {
          const mine = rows.filter((row) => row.detail?.stage === stage);
          if (!nudgeWent(mine.map((row) => row.action))) continue;
          const claim = mine.filter((row) => row.action === ACTIVATION_NUDGE_SENT).at(-1);
          if (!claim) continue;
          const verdicts =
            stage === "first_verdict"
              ? (unwrap(await db().from("ledger_entries").select("seq").eq("action", "decision_verdict").gt("ts", claim.ts).limit(1)) as unknown[])
              : [];
          sent.push({ orgId, stage, at: claim.ts, verdictAfter: verdicts.length > 0 });
        }
        return sent;
      }).catch(() => [] as SentNudge[])
    )
  );
  return found.flat();
}
