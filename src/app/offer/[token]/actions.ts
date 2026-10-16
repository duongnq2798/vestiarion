"use server";

import "server-only";

import { decideOffer } from "@/lib/early-pay/offers";

/**
 * The supplier's answer to an early-payment offer (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E4-E6).
 * No session: the one-time link is the supplier's only credential. Nothing from a failure reaches the supplier but a
 * fixed sentence.
 */

export interface OfferDecisionResult {
  ok: boolean;
  message: string;
  outcome?: "accepted" | "declined";
}

const NOT_VALID = "This link is no longer valid. Ask the business that sent it for a new one.";

export async function decideOfferAction(_previous: OfferDecisionResult, formData: FormData): Promise<OfferDecisionResult> {
  const token = formData.get("token");
  const accept = formData.get("decision") === "accept";
  try {
    const outcome = await decideOffer(typeof token === "string" ? token : "", accept);
    if (outcome === "accepted") return { ok: true, outcome, message: "Accepted. The business pays you today, at the discounted amount, once its usual checks pass." };
    if (outcome === "declined") return { ok: true, outcome, message: "Declined. Your invoice is paid as planned, on its due date." };
    if (outcome === "bill_changed") return { ok: false, message: "This invoice changed since the offer was made, so nothing changed. Ask the business for a new offer." };
    return { ok: false, message: NOT_VALID };
  } catch {
    console.error("early-payment offer decision failed");
    return { ok: false, message: "That did not work. Try again in a moment." };
  }
}
