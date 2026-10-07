"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { endShadowMode, ShadowModeError, startShadowMode } from "@/lib/shadow-mode";

/**
 * Turns shadow mode on, in the business's currency, or off, from Settings
 * (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1): an owner's alone. The library refuses Arc mainnet and a
 * change while a cycle runs, and writes the signed entry. Turning it off frees nothing at once: a payment held for a
 * person to agree stays held until a person decides it.
 */

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
      const started = await startShadowMode({ actorId: auth.user.id, currency: formString(formData, "currency") });
      revalidateOrgPages();
      return { ok: true, message: `Shadow mode is on, for bills in ${started.currency}: the agent pays nothing until a person agrees.` };
    } catch (error) {
      if (error instanceof ShadowModeError) return { ok: false, message: error.message };
      console.error("shadow mode change failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
