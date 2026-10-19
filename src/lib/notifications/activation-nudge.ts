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
import { emailSettingsFromEnv, IDEMPOTENCY_KEY_USED, SEND_TIMEOUT_MS, sendEmail } from "../email/send";
import type { NudgeRow as SentNudge } from "../growth/metrics";
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
  skipped?: "sent_before" | "gave_up" | "not_due" | "no_email" | "nobody" | "out_of_time" | "failed";
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Resend's idempotency key for one member's reminder: two ticks at once send it once (A6). No address in it. */
export function nudgeKey(orgId: string, stage: NudgeStage, userId: string): string {
  return sha256(["activation_nudge", orgId, stage, userId].join("\n"));
}

/** Whether the workspace in scope has a real bill, as `growth_workspaces` counts them: a payable of a counterparty not sample. */
async function hasRealBill(): Promise<boolean> {
  const rows = unwrap(
    await db().from("invoices").select("id, counterparties!inner(sample)").eq("direction", "payable").eq("counterparties.sample", false).limit(1)
  ) as unknown[];
  return rows.length > 0;
}

/**
 * Sends one workspace's reminder for `due.stage`, in that workspace's scope (A1-A4, A6): skipped when it went already,
 * failed too often, or is no longer due. Signs `activation_nudge_sent` before the emails go, and
 * `activation_nudge_failed` when none went. With `sendBy` (ms since the epoch), no send starts that could still be
 * waiting for Resend after it, and nothing is claimed when not even one could: the tick keeps its margin (A5).
 */
export async function sendActivationNudge(due: DueNudge, options: { now?: number; sendBy?: number } = {}): Promise<NudgeOutcome> {
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
      if (await hasRealBill()) return { ...outcome, skipped: "not_due" };
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
    // The last moment a send may start: one still waiting for Resend then would run into the tick's margin.
    const lastStart = Math.min(Date.now() + DIGEST_SEND_DEADLINE_MS, (options.sendBy ?? Infinity) - SEND_TIMEOUT_MS);
    if (Date.now() >= lastStart) return { ...outcome, skipped: "out_of_time" };

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

    for (const [index, recipient] of recipients.entries()) {
      if (Date.now() >= lastStart) {
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
  /** Workspaces whose reminder was claimed this tick: what `NUDGES_PER_TICK` counts. */
  attempted: number;
  emails: number;
  skipped: Record<string, number>;
  /** Due workspaces not visited this tick: past `startBy`, or once `NUDGES_PER_TICK` were claimed. */
  left: number;
}

/**
 * The tick's pass (A5): reads `growth_workspaces` for the last 30 days once, picks the reminders due, and sends each in
 * its workspace's scope, one workspace after another, oldest first. A workspace whose reminder went already, or that
 * is no longer due, costs one ledger read and does not count: the pass stops once `NUDGES_PER_TICK` reminders were
 * claimed, so the workspaces reminded before never crowd out a new one. None starts after `startBy`, and no send after
 * `sendBy`. Never throws.
 */
export async function runActivationNudges(
  options: { now?: number; startBy?: number; sendBy?: number; clock?: () => number } = {}
): Promise<NudgePassResult> {
  const nowMs = options.now ?? Date.now();
  const clock = options.clock ?? Date.now;
  const result: NudgePassResult = { due: 0, reminded: 0, attempted: 0, emails: 0, skipped: {}, left: 0 };
  const late = () => options.startBy !== undefined && clock() > options.startBy;
  try {
    if (!emailSettingsFromEnv() || late()) return result;
    const workspaces = await readWorkspaces(new Date(nowMs - NUDGE_WINDOW_MS));
    if (!workspaces) return result;
    const due = dueNudges(workspaces, nowMs);
    result.due = due.length;
    for (const [index, nudge] of due.entries()) {
      if (result.attempted >= NUDGES_PER_TICK || late()) {
        result.left = due.length - index;
        if (late()) console.warn("activation nudges left to the next tick: out of time", due.length - index);
        break;
      }
      const outcome = await withOrg(nudge.orgId, () => sendActivationNudge(nudge, { now: nowMs, sendBy: options.sendBy })).catch((error: unknown) => {
        console.error("activation nudge: workspace not entered", nudge.slug, error instanceof Error ? error.message : String(error));
        return { sent: 0, failed: 0, skipped: "failed" } as NudgeOutcome;
      });
      result.emails += outcome.sent;
      if (outcome.sent > 0 || outcome.failed > 0) result.attempted += 1;
      if (outcome.sent > 0) result.reminded += 1;
      else if (outcome.skipped) result.skipped[outcome.skipped] = (result.skipped[outcome.skipped] ?? 0) + 1;
    }
    return result;
  } catch (error) {
    console.error("activation nudges: failed", error instanceof Error ? error.message : String(error));
    return result;
  }
}

/** At most this many workspaces' ledgers are read for the tile, and this many at once. */
export const NUDGE_READ_LIMIT = 100;
const NUDGE_READ_LANES = 8;

/**
 * The reminders that went in these workspaces (A7), read from each one's ledger in its scope: a claim still standing
 * (not let go by a failure) counts. Best effort: a workspace that cannot be read counts as not reminded.
 */
export async function readSentNudges(orgIds: readonly string[]): Promise<SentNudge[]> {
  const ids = orgIds.slice(0, NUDGE_READ_LIMIT);
  const found: SentNudge[][] = new Array(ids.length);
  let next = 0;
  const readOne = (orgId: string) =>
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
      }).catch(() => [] as SentNudge[]);
  await Promise.all(
    Array.from({ length: Math.min(NUDGE_READ_LANES, ids.length) }, async () => {
      while (next < ids.length) {
        const index = next++;
        found[index] = await readOne(ids[index]);
      }
    })
  );
  return found.flat();
}
