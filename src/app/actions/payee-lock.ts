"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { changePayeeLock, lockEased, PayeeLockError } from "@/lib/payee-lock";

/**
 * Turns the payee lock on or off, or changes its wait after an address changes, from Settings
 * (docs/superpowers/specs/2026-10-20-payee-lock-design.md PL1): an owner's alone, as the two approvals figure is. The
 * library refuses a change while a cycle runs and writes the signed entry. Turning it on or lengthening the wait frees
 * nothing. Turning it off or shortening the wait may end a wait already passed under the new hours, which the due-work
 * watch would not see as newly ended, so it starts a cycle now (due-work watch DW8).
 */

export interface PayeeLockActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function setPayeeLockAction(_previous: PayeeLockActionResult, formData: FormData): Promise<PayeeLockActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.policy");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const hoursText = formString(formData, "coolingHours").trim();
    const coolingHours = hoursText === "" ? 0 : Number(hoursText);
    try {
      const { from, to } = await changePayeeLock({ actorId: auth.user.id, on: formString(formData, "on") === "on", coolingHours });
      if (lockEased(from, to)) raiseCycleEvent(auth, "payee_lock_eased");
      revalidateOrgPages();
      return {
        ok: true,
        message: !to.on
          ? "The payee lock is off."
          : to.coolingHours > 0
            ? `The payee lock is on: a changed address waits ${to.coolingHours} hours before it is paid.`
            : "The payee lock is on.",
      };
    } catch (error) {
      if (error instanceof PayeeLockError) return { ok: false, message: error.message };
      console.error("payee lock change failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
