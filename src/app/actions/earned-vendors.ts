"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { changeEarnedVendorRule, EarnedVendorsError } from "@/lib/earned-vendors-store";

/**
 * Sets, changes or turns off the workspace's rule for earned vendors, from Settings
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11, AL17): an owner's alone, as the payee lock is. The
 * library refuses a change on Arc mainnet, while a cycle runs or when it cannot be signed, and signs the change and the
 * statuses under it. Earning grants nothing (AL20), so nothing held is freed and no cycle starts.
 */

export interface EarnedVendorsActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function setEarnedVendorRuleAction(_previous: EarnedVendorsActionResult, formData: FormData): Promise<EarnedVendorsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.policy");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    // Turn off is its own button; an empty field under Save is a number the library refuses, never off.
    const text = formString(formData, "streak").trim();
    const streak = formString(formData, "intent") === "off" ? null : text === "" ? Number.NaN : Number(text);
    try {
      const { to } = await changeEarnedVendorRule({ actorId: auth.user.id, streak });
      revalidateOrgPages();
      return { ok: true, message: to === null ? "Earned vendors are off." : `Earned vendors: ${to} agreed verdicts in a row.` };
    } catch (error) {
      if (error instanceof EarnedVendorsError) return { ok: false, message: error.message };
      console.error("earned vendors change failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
