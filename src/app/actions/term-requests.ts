"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { setTermRequests, TermRequestError } from "@/lib/terms/requests";

/**
 * The agent's requests for more time turned on, with the most days it asks for, or off
 * (docs/superpowers/specs/2026-10-17-term-requests-design.md X1). Turning them on starts a cycle, so the bills already
 * held for cash are weighed now.
 */

export interface TermRequestsActionResult {
  ok: boolean;
  message: string;
}

export async function setTermRequestsAction(_previous: TermRequestsActionResult, formData: FormData): Promise<TermRequestsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const on = formData.get("on") === "true";
  const maxDays = on ? Number(String(formData.get("maxDays") ?? "").trim()) : null;
  return inOrg(auth, async () => {
    try {
      await setTermRequests({ orgId: auth.membership.orgId, actorId: auth.user.id, on, maxDays });
      revalidateOrgPages();
      if (on) raiseCycleEvent(auth, "term_requests_on");
      return { ok: true, message: on ? "The agent now asks suppliers for more time on bills held for cash." : "The agent no longer asks for more time. Requests already out still stand." };
    } catch (error) {
      if (error instanceof TermRequestError) return { ok: false, message: error.message };
      console.error("setTermRequestsAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
