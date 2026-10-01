"use server";

import "server-only";

import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { DismissalError, dismissScreeningMatch } from "@/lib/screening-dismissal";

export interface DismissMatchResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

const inputSchema = z.object({
  counterpartyId: z.string().uuid(),
  matchedEntityId: z.string().trim().min(1).max(200),
});

/**
 * Not this person (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md): for the
 * members who can decide approvals (R1), since a dismissal restores payment authority. A cycle follows
 * within a minute, so payments held on the old risk are decided again.
 */
export async function dismissScreeningMatchAction(_previous: DismissMatchResult, formData: FormData): Promise<DismissMatchResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = inputSchema.safeParse({ counterpartyId: formString(formData, "counterpartyId"), matchedEntityId: formString(formData, "matchedEntityId") });
    if (!parsed.success) return { ok: false, message: "Counterparty not found." };
    try {
      const result = await dismissScreeningMatch({ ...parsed.data, actorId: auth.user.id, reason: formString(formData, "reason") });
      revalidateOrgPages();
      if (!result.rescreened) {
        return { ok: true, message: `Dismissed. Screening could not be reached just now; ${result.name} is screened again at the next cycle.` };
      }
      raiseCycleEvent(auth, "match_dismissed");
      const limit = result.paymentLimit == null ? "" : `, limit ${result.paymentLimit} USDC`;
      return {
        ok: true,
        message: `Dismissed. ${result.name} screened again: ${result.riskLevel} risk${limit}. Payments held on the old risk are decided again within a minute.`,
      };
    } catch (error) {
      if (error instanceof DismissalError) return { ok: false, message: error.message };
      console.error("dismiss screening match failed", error instanceof Error ? error.message : error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
