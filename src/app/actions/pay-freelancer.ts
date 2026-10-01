"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { parseFreelancerPayment, setUpFreelancerPayment } from "@/lib/pay-freelancer";

export interface PayFreelancerResult {
  ok: boolean;
  message: string;
  /** The payee link, shown once, to copy. */
  url?: string;
  name?: string;
  /** True when emailed, false when the email did not go out, null when no email was given. */
  emailed?: boolean | null;
  expiresAt?: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Pays a freelancer in one step (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md):
 * the contractor, a verified milestone for the work, and a payee link, emailed when an email is given.
 */
export async function payFreelancerAction(_previous: PayFreelancerResult, formData: FormData): Promise<PayFreelancerResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = parseFreelancerPayment({
      name: formString(formData, "name"),
      email: formString(formData, "email"),
      work: formString(formData, "work"),
      amount: formString(formData, "amount"),
      evidence: formString(formData, "evidence"),
    });
    if (!parsed.ok) return { ok: false, message: parsed.message };

    try {
      const result = await setUpFreelancerPayment({ ...parsed.value, actorId: auth.user.id, orgName: auth.membership.name });
      revalidateOrgPages();
      // A sandbox pays simulated at once; a live workspace waits for the address and its confirmation (R5),
      // whose own event starts the cycle that pays.
      if (auth.membership.mode === "sandbox") raiseCycleEvent(auth, "milestone_verified");
      const next = "When they add their address you get an email; confirm it on Counterparties and the agent pays within a minute.";
      const message =
        result.emailed === true
          ? `Emailed ${result.name} a link to add the address to be paid at. ${next}`
          : result.emailed === false
            ? `The email to ${result.name} did not go out. Send them this link instead. ${next}`
            : `Send ${result.name} this link to add the address to be paid at. ${next}`;
      return { ok: true, message, url: result.url, name: result.name, emailed: result.emailed, expiresAt: result.expiresAt };
    } catch (error) {
      console.error("pay a freelancer failed", error instanceof Error ? error.message : error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
