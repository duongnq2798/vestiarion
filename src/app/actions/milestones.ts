"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasAgentControlSession } from "@/lib/agent-session";
import { appendLedgerEntry } from "@/lib/ledger";
import { supabase, unwrap } from "@/lib/supabase";

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
  if (!(await hasAgentControlSession())) return { ok: false, message: "Control session expired." };
  const parsed = manualVerificationSchema.safeParse({
    milestoneId: formData.get("milestoneId"),
    intent: formData.get("intent"),
    note: formData.get("note"),
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid verification input." };

  const { milestoneId, intent, note } = parsed.data;
  const milestone = unwrap(
    await supabase()
      .from("milestones")
      .select("id, title, verified, status, verification_source")
      .eq("id", milestoneId)
      .single<{ id: string; title: string; verified: boolean; status: string; verification_source: string | null }>()
  );
  if (milestone.status === "paid" && intent === "revoke") {
    return { ok: false, message: "A paid milestone cannot be unverified; record a correcting audit action instead." };
  }

  const verified = intent === "verify";
  const now = new Date().toISOString();
  const update = await supabase().from("milestones").update({
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
      milestoneId: milestone.id,
      verificationSource: milestone.verification_source,
      verificationMethod: "manual",
      previousVerified: milestone.verified,
      verified,
      note,
    },
  });

  revalidatePath("/contractors");
  revalidatePath("/audit");
  return { ok: true, message: verified ? "Manual verification recorded." : "Verification revoked and recorded." };
}
