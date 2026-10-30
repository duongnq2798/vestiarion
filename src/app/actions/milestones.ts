"use server";

import "server-only";

import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { AsanaNotSetUpError, liveLinks } from "@/lib/asana/links";
import { LinearNotSetUpError, liveLinks as linearLinks } from "@/lib/linear/links";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { milestoneInputSchema } from "@/lib/intake-validation";
import { appendLedgerEntry } from "@/lib/ledger";
import { consoleActor } from "@/lib/commands/actor";
import { addMilestone, closeMilestoneUnpaid, payMilestoneNow } from "@/lib/commands/milestones";
import { assignToProjectCommand } from "@/lib/commands/projects";
import { consoleAnswer } from "./command-result";

export interface MilestoneActionResult {
  ok: boolean;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Records work a contractor is to be paid for, as a pending milestone, through the command every surface shares
 * (`addMilestone`, write API part 2 W4): the form's fields are checked here, the contractor and the rest there.
 */
export async function createMilestoneAction(
  _previous: MilestoneActionResult,
  formData: FormData
): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = milestoneInputSchema.safeParse({
      contractorId: formString(formData, "contractorId"),
      title: formString(formData, "title"),
      amount: formString(formData, "amount"),
      evidence: formString(formData, "evidence"),
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid milestone input." };
    // The purchase order the work was agreed under, and the project it belongs to (project budgets P3, P9): the console's
    // own fields, read here, never the write API's.
    const poReference = formString(formData, "poReference").trim().slice(0, 100) || null;
    const projectId = formString(formData, "projectId").trim();
    const actor = consoleActor(auth);
    const added = await addMilestone(actor, { milestone: parsed.data, poReference });
    if (!added.ok || !UUID.test(projectId)) return consoleAnswer(added);
    const placed = await assignToProjectCommand(actor, { subject: { kind: "milestone", id: added.milestoneId }, projectId, atEntry: true });
    return consoleAnswer({ ...added, message: placed.ok ? `${added.message} ${placed.message}` : `${added.message} It was not put in the project: ${placed.message}` });
  });
}

/** A milestone's live link to a Linear issue, and its state; none, before migration 0147. */
async function linearLinkOf(milestoneId: string): Promise<{ state: string } | null> {
  try {
    return (await linearLinks({ milestoneIds: [milestoneId] }))[0] ?? null;
  } catch (error) {
    if (error instanceof LinearNotSetUpError) return null;
    throw error;
  }
}

/** Whether a milestone is linked to an Asana task; never, before migration 0115. */
async function asanaLinked(milestoneId: string): Promise<boolean> {
  try {
    return (await liveLinks({ milestoneIds: [milestoneId] })).length > 0;
  } catch (error) {
    if (error instanceof AsanaNotSetUpError) return false;
    throw error;
  }
}

const manualVerificationSchema = z.object({
  milestoneId: z.string().uuid(),
  intent: z.enum(["verify", "revoke"]),
  note: z.string().trim().min(3, "Add a short verification note").max(280),
});

export async function manualMilestoneVerificationAction(
  _previous: MilestoneActionResult,
  formData: FormData
): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = manualVerificationSchema.safeParse({
      milestoneId: formData.get("milestoneId"),
      intent: formData.get("intent"),
      note: formData.get("note"),
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid verification input." };

    const { milestoneId, intent, note } = parsed.data;
    // Scoped to the organization: another organization's milestone id is
    // answered exactly like one that does not exist.
    const lookup = await db()
      .from("milestones")
      .select("id, title, verified, status, verification_source")
      .eq("id", milestoneId)
      .maybeSingle<{ id: string; title: string; verified: boolean; status: string; verification_source: string | null }>();
    if (lookup.error) throw new Error(lookup.error.message);
    const milestone = lookup.data;
    if (!milestone) return { ok: false, message: "Milestone not found." };
    if (milestone.status === "paid" && intent === "revoke") {
      return { ok: false, message: "A paid milestone cannot be unverified; record a correcting audit action instead." };
    }
    // Closed without paying is final: verifying it again would have the agent pay it.
    if (milestone.status === "closed") {
      return { ok: false, message: "This milestone was closed without paying. Add it again if the work is still owed." };
    }
    // Work delivered in Asana is accepted against its criteria, as the version a person saw, never verified around that
    // (Asana acceptance A8). Revoking stays open.
    if (intent === "verify" && (await asanaLinked(milestone.id))) {
      return { ok: false, message: "This milestone's work is accepted from its Asana task. Accept it there against its criteria, or unlink the task first." };
    }
    // So is work delivered in Linear (Linear acceptance LN8). An acceptance from Linear is taken back with its issue, which
    // holds it for review before any payment (LN10): revoked here, the issue's card would still say it was accepted.
    const linearLink = await linearLinkOf(milestone.id);
    if (intent === "verify" && linearLink) {
      return { ok: false, message: "This milestone's work is accepted from its Linear issue. Accept it there against its criteria, or unlink the issue first." };
    }
    if (intent === "revoke" && linearLink?.state === "accepted") {
      return { ok: false, message: "This milestone's work was accepted from its Linear issue. Unlink the issue to take the acceptance back." };
    }

    const verified = intent === "verify";
    const now = new Date().toISOString();
    const update = await db().from("milestones").update({
      verified,
      status: milestone.status === "paid" ? "paid" : verified ? "verified" : "pending",
      verification_method: "manual",
      verification_status: verified ? "verified" : "unverified",
      verification_checked_at: now,
      verified_at: verified ? now : null,
      verification_detail: { note },
    }).eq("id", milestone.id);
    if (update.error) return { ok: false, message: update.error.message };

    await appendLedgerEntry({
      actor: "human",
      domain: "contractor",
      action: verified ? "verify_milestone_manual" : "revoke_milestone_verification",
      summary: `${verified ? "Verified" : "Revoked verification for"} milestone “${milestone.title}” manually`,
      detail: {
        by: auth.user.id,
        milestoneId: milestone.id,
        verificationSource: milestone.verification_source,
        verificationMethod: "manual",
        previousVerified: milestone.verified,
        verified,
        note,
      },
    });

    revalidateOrgPages();
    // A verified milestone that is not yet paid is one the agent can release.
    if (verified && milestone.status !== "paid") raiseCycleEvent(auth, "milestone_verified");
    return { ok: true, message: verified ? "Manual verification recorded." : "Verification revoked and recorded." };
  });
}

const milestoneIdSchema = z.string().uuid();

/**
 * Pays a held milestone now (held milestone actions R2): a person's decision, by anyone who may approve a
 * held payable. The release still passes the contractor's risk, limit and address checks, inside the command
 * every surface shares (src/lib/commands/milestones.ts).
 */
export async function payHeldMilestoneAction(_previous: MilestoneActionResult, formData: FormData): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = milestoneIdSchema.safeParse(formString(formData, "milestoneId"));
    if (!parsed.success) return { ok: false, message: "Milestone not found." };
    return consoleAnswer(await payMilestoneNow(consoleActor(auth), { milestoneId: parsed.data }));
  });
}

/** Closes a held milestone without paying it, with the reason a person gives (held milestone actions R3). */
export async function closeMilestoneAction(_previous: MilestoneActionResult, formData: FormData): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = milestoneIdSchema.safeParse(formString(formData, "milestoneId"));
    if (!parsed.success) return { ok: false, message: "Milestone not found." };
    return consoleAnswer(await closeMilestoneUnpaid(consoleActor(auth), { milestoneId: parsed.data, reason: formString(formData, "reason") }));
  });
}
