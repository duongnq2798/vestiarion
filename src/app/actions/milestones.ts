"use server";

import "server-only";

import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { milestoneInputSchema } from "@/lib/intake-validation";
import { appendLedgerEntry } from "@/lib/ledger";
import { consoleActor } from "@/lib/commands/actor";
import { addMilestone, closeMilestoneUnpaid, payMilestoneNow } from "@/lib/commands/milestones";
import { consoleAnswer } from "./command-result";

export interface MilestoneActionResult {
  ok: boolean;
  message: string;
}

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
    return consoleAnswer(await addMilestone(consoleActor(auth), { milestone: parsed.data }));
  });
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
