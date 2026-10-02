"use server";

import "server-only";

import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { MATCHES_KEPT, screenCounterparty } from "@/lib/compliance";
import { inOrg } from "@/lib/dal/scope";
import { DismissalError, dismissScreeningMatch } from "@/lib/screening-dismissal";

export interface DismissMatchResult {
  ok: boolean;
  message: string;
}

/** "Dismissed." for the one match a card showed, "Dismissed 16 matches." for a review of several. */
function dismissedWord(count: number): string {
  return count > 1 ? `Dismissed ${count} matches.` : "Dismissed.";
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

const inputSchema = z.object({
  counterpartyId: z.string().uuid(),
  // Every match the card listed (review every match R3).
  matchedEntityIds: z.array(z.string().trim().min(1).max(200)).min(1).max(MATCHES_KEPT),
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
    const parsed = inputSchema.safeParse({
      counterpartyId: formString(formData, "counterpartyId"),
      matchedEntityIds: formData.getAll("matchedEntityId").filter((value): value is string => typeof value === "string"),
    });
    if (!parsed.success) return { ok: false, message: "Counterparty not found." };
    try {
      const result = await dismissScreeningMatch({ ...parsed.data, actorId: auth.user.id, reason: formString(formData, "reason") });
      revalidateOrgPages();
      if (!result.rescreened) {
        return { ok: true, message: `${dismissedWord(result.dismissed)} Screening could not be reached just now; ${result.name} is screened again at the next cycle.` };
      }
      raiseCycleEvent(auth, "match_dismissed");
      const limit = result.paymentLimit == null ? "" : `, limit ${result.paymentLimit} USDC`;
      return {
        ok: true,
        message: `${dismissedWord(result.dismissed)} ${result.name} screened again: ${result.riskLevel} risk${limit}. Payments held on the old risk are decided again within a minute.`,
      };
    } catch (error) {
      if (error instanceof DismissalError) return { ok: false, message: error.message };
      console.error("dismiss screening match failed", error instanceof Error ? error.message : error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

/**
 * Screens one counterparty again, now. For a match recorded before each verdict kept the entity it matched
 * (migration 0051): until it is screened again it has no entity to dismiss, so Not this person cannot be offered.
 * The same members who may dismiss a match may ask for it.
 */
export async function screenAgainAction(_previous: DismissMatchResult, formData: FormData): Promise<DismissMatchResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = inputSchema.shape.counterpartyId.safeParse(formString(formData, "counterpartyId"));
    if (!parsed.success) return { ok: false, message: "Counterparty not found." };
    try {
      const outcome = await screenCounterparty(parsed.data);
      revalidateOrgPages();
      // A changed verdict changes what the agent may pay: payments held on the old one are decided again.
      if (outcome.riskLevel !== outcome.previousRiskLevel) raiseCycleEvent(auth, "match_dismissed");
      const still = outcome.riskLevel === "medium" || outcome.riskLevel === "high";
      return {
        ok: true,
        message: still
          ? `${outcome.name} screened again: ${outcome.riskLevel} risk. If it is someone else, choose Not this person.`
          : `${outcome.name} screened again: ${outcome.riskLevel} risk.`,
      };
    } catch (error) {
      console.error("screen again failed", error instanceof Error ? error.message : error);
      return { ok: false, message: "Screening could not be reached just now. Try again in a moment." };
    }
  });
}
