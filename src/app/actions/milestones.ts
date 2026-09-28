"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { appendLedgerEntry } from "@/lib/ledger";

export interface MilestoneActionResult {
  ok: boolean;
  message: string;
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
    return { ok: true, message: verified ? "Manual verification recorded." : "Verification revoked and recorded." };
  });
}
