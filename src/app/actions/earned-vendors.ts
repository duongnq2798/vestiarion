"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { changeEarnedVendorPayments, changeEarnedVendorRule, EarnedVendorsError } from "@/lib/earned-vendors-store";

/**
 * Sets, changes or turns off the workspace's rule for earned vendors, from Settings
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11, AL17): an owner's alone, as the payee lock is. The
 * library refuses a change on Arc mainnet, while a cycle runs or when it cannot be signed, and signs the change and the
 * statuses under it. A failure other than its refusals may leave a rule in force without its entry, so the page is read
 * again. Earning grants nothing by itself (AL20), so nothing held is freed and no cycle starts.
 *
 * Beside it, the owner's switch that lets the agent pay earned vendors on their own in shadow mode (AL21): an owner's
 * too, refused by the library without a rule or an agent spending limit. It frees nothing already held for a verdict:
 * only the agent's next decisions are paid this way (AL22), so no cycle starts either.
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
      // It may have left the rule changed without its entry (AL17): Settings shows the rule in force, and asking for it
      // again signs it.
      revalidateOrgPages();
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

export async function setEarnedVendorPaymentsAction(_previous: EarnedVendorsActionResult, formData: FormData): Promise<EarnedVendorsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.policy");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const { to } = await changeEarnedVendorPayments({ actorId: auth.user.id, on: formString(formData, "on") === "true" });
      revalidateOrgPages();
      return { ok: true, message: to ? "The agent pays earned vendors on its own now, and you give your verdict after." : "Earned vendors' payments wait for your verdict again." };
    } catch (error) {
      if (error instanceof EarnedVendorsError) return { ok: false, message: error.message };
      console.error("earned vendors switch change failed", error instanceof Error ? error.message : "unknown error");
      // It may have left the switch changed without its entry (AL21): Settings shows the switch in force.
      revalidateOrgPages();
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
