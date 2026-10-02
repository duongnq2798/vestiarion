"use server";

import "server-only";

import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { currentConfig } from "@/lib/context";
import { db, unwrap } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { parseGitHubPullRequestUrl } from "@/lib/github-verification";
import { isHttpsLink, usdcAmountSchema } from "@/lib/intake-validation";
import { appendLedgerEntry } from "@/lib/ledger";
import { closeMilestone, MilestoneDecisionError, payHeldMilestone } from "@/lib/agent/milestone-decisions";

export interface MilestoneActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

const milestoneInputSchema = z.object({
  contractorId: z.string().uuid("Choose a contractor"),
  title: z.string().trim()
    .min(3, "Say what was delivered, in at least 3 characters")
    .max(160, "Keep the milestone to 160 characters"),
  amount: usdcAmountSchema,
  evidence: z.string().trim()
    .max(500, "Keep the evidence link to 500 characters")
    .refine((value) => value === "" || isHttpsLink(value), "The evidence link must start with https://")
    .transform((value) => value || null),
});

/**
 * Records work a contractor is to be paid for, as a pending milestone. A
 * GitHub pull request link is kept in its canonical form, so the cycle's
 * GitHub check (`refreshGitHubMilestones`) verifies it once it is merged, and
 * the event has that check run within a minute. Without a GitHub token that
 * check reports itself unavailable, so the form promises it only when one is
 * configured. Any other link is evidence for the person who verifies the work
 * by hand. Either way the agent pays only a verified milestone, and only after
 * its own release decision and guardrails.
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

    const input = parsed.data;
    // Scoped to the organization: another organization's counterparty id is
    // answered exactly like one that does not exist.
    const lookup = await db()
      .from("counterparties")
      .select("id, name, role")
      .eq("id", input.contractorId)
      .maybeSingle<{ id: string; name: string; role: string }>();
    if (lookup.error) throw new Error(lookup.error.message);
    const contractor = lookup.data;
    if (!contractor) return { ok: false, message: "Contractor not found." };
    if (contractor.role === "client") return { ok: false, message: "A client is not paid for milestones. Choose a contractor or vendor." };

    const pullRequest = parseGitHubPullRequestUrl(input.evidence);
    const verificationSource = pullRequest?.url ?? input.evidence;
    const milestone = unwrap(
      await db()
        .from("milestones")
        .insert({
          contractor_id: contractor.id,
          title: input.title,
          amount: input.amount,
          verification_source: verificationSource,
        })
        .select("id")
        .single<{ id: string }>()
    );

    await appendLedgerEntry({
      actor: "human",
      domain: "contractor",
      action: "create_milestone",
      summary: `Added milestone “${input.title}” for ${contractor.name}: ${input.amount} USDC`,
      detail: {
        by: auth.user.id,
        milestoneId: milestone.id,
        counterpartyId: contractor.id,
        counterpartyName: contractor.name,
        amount: input.amount,
        verificationSource,
      },
    });

    revalidateOrgPages();
    if (!pullRequest || !currentConfig().githubToken) {
      return {
        ok: true,
        message: `Milestone added for ${contractor.name}. Verify it once the work is delivered, and the agent decides on pay within a minute.`,
      };
    }
    raiseCycleEvent(auth, "milestone_added");
    return {
      ok: true,
      message: `Milestone added for ${contractor.name}. The agent checks the pull request within a minute, and decides on pay once it is merged.`,
    };
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

/** A `MilestoneDecisionError` carries a message safe to show; anything else stays in the server log. */
function decisionFailed(error: unknown): MilestoneActionResult {
  if (error instanceof MilestoneDecisionError) return { ok: false, message: error.message };
  console.error("milestone decision failed", error instanceof Error ? error.message : error);
  return { ok: false, message: "That did not work. Try again in a moment: nothing is sent twice." };
}

/**
 * Pays a held milestone now (held milestone actions R2): a person's decision, by anyone who may approve a
 * held payable. The release still passes the contractor's risk, limit and address checks.
 */
export async function payHeldMilestoneAction(_previous: MilestoneActionResult, formData: FormData): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = milestoneIdSchema.safeParse(formString(formData, "milestoneId"));
    if (!parsed.success) return { ok: false, message: "Milestone not found." };
    try {
      const result = await payHeldMilestone({ actorId: auth.user.id, milestoneId: parsed.data });
      revalidateOrgPages();
      if (result.status === "paid") return { ok: true, message: "Paid." };
      if (result.status === "verified") return { ok: true, message: "Payment submitted; waiting for Circle to confirm it." };
      const reason = /\[(?:transfer|execution) failed:\s*(.+?)\]\s*$/.exec(result.note)?.[1] ?? /\[not paid:\s*(.+?)\]\s*$/.exec(result.note)?.[1];
      return { ok: false, message: reason ? `Not paid: ${reason}. The milestone is still held.` : "Not paid. The milestone is still held." };
    } catch (error) {
      return decisionFailed(error);
    }
  });
}

/** Closes a held milestone without paying it, with the reason a person gives (held milestone actions R3). */
export async function closeMilestoneAction(_previous: MilestoneActionResult, formData: FormData): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = milestoneIdSchema.safeParse(formString(formData, "milestoneId"));
    if (!parsed.success) return { ok: false, message: "Milestone not found." };
    try {
      await closeMilestone({ actorId: auth.user.id, milestoneId: parsed.data, reason: formString(formData, "reason") });
      revalidateOrgPages();
      return { ok: true, message: "Closed without paying." };
    } catch (error) {
      return decisionFailed(error);
    }
  });
}
