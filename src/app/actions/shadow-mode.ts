"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { readEarnedVendorRule, shadowModePaysWords } from "@/lib/earned-vendors-store";
import { endShadowMode, ShadowModeError, startShadowMode } from "@/lib/shadow-mode";

/**
 * Turns shadow mode on, in the business's currency, or off, from Settings
 * (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1): an owner's alone. The library refuses Arc mainnet and a
 * change while a cycle runs, and writes the signed entry. Turning it off frees nothing at once: a payment held for a
 * person to agree stays held until a person decides it. Turned on again while the owner lets the agent pay earned
 * vendors on their own, it says so (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL28).
 */

/** The owner's switch for earned vendors, for what the toast and the entry say; best effort: a failed read leaves it out. */
async function earnedPaymentsOn(): Promise<boolean> {
  try {
    return (await readEarnedVendorRule(db())).payments;
  } catch (error) {
    console.error("shadow mode: earned vendors not read", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

export interface ShadowModeActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function setShadowModeAction(_previous: ShadowModeActionResult, formData: FormData): Promise<ShadowModeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.policy");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      if (formString(formData, "intent") === "end") {
        await endShadowMode({ actorId: auth.user.id });
        revalidateOrgPages();
        return { ok: true, message: "Shadow mode is off: the agent pays on its own again, within its limits." };
      }
      const earnedPayments = await earnedPaymentsOn();
      const started = await startShadowMode({ actorId: auth.user.id, currency: formString(formData, "currency"), earnedPayments });
      revalidateOrgPages();
      return { ok: true, message: `Shadow mode is on, for bills in ${started.currency}: ${shadowModePaysWords(earnedPayments)}.` };
    } catch (error) {
      if (error instanceof ShadowModeError) return { ok: false, message: error.message };
      console.error("shadow mode change failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
