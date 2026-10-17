"use server";

import "server-only";

import { counterTermRequest, decideTermRequest } from "@/lib/terms/requests";

/**
 * The supplier's answer to a request for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md X4, X5).
 * No session: the one-time link is the supplier's only credential. Nothing from a failure reaches the supplier but a
 * fixed sentence.
 */

export interface TermDecisionResult {
  ok: boolean;
  message: string;
  outcome?: "accepted" | "declined" | "countered";
}

const NOT_VALID = "This link is no longer valid. Ask the business that sent it for a new one.";

export async function decideTermRequestAction(_previous: TermDecisionResult, formData: FormData): Promise<TermDecisionResult> {
  const token = formData.get("token");
  const accept = formData.get("decision") === "accept";
  try {
    const outcome = await decideTermRequest(typeof token === "string" ? token : "", accept);
    if (outcome === "accepted") return { ok: true, outcome, message: "Agreed. The invoice now falls due on the new date, for the same amount." };
    if (outcome === "declined") return { ok: true, outcome, message: "Declined. The invoice stays due on its original date." };
    if (outcome === "bill_changed") return { ok: false, message: "This invoice changed since the request was made, so nothing changed. Ask the business for a new request." };
    return { ok: false, message: NOT_VALID };
  } catch {
    console.error("term request decision failed");
    return { ok: false, message: "That did not work. Try again in a moment." };
  }
}

/**
 * The supplier's counter (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md F5): fewer days than asked,
 * which the agent answers by email.
 */
export async function counterTermRequestAction(_previous: TermDecisionResult, formData: FormData): Promise<TermDecisionResult> {
  const token = formData.get("token");
  const days = Number(String(formData.get("days") ?? "").trim());
  try {
    const outcome = await counterTermRequest(typeof token === "string" ? token : "", days);
    if (outcome === "countered") return { ok: true, outcome, message: "Sent. The business answers you by email shortly. Until then, the invoice stays due on its original date." };
    if (outcome === "bad_days") return { ok: false, message: "Propose a whole number of days, from 1 to fewer than asked." };
    return { ok: false, message: NOT_VALID };
  } catch {
    console.error("term request counter failed");
    return { ok: false, message: "That did not work. Try again in a moment." };
  }
}
