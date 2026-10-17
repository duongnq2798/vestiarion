"use server";

import "server-only";

import { siteOrigin } from "@/lib/auth/env";
import { decideDiscount } from "@/lib/customer-offers/store";

/**
 * The customer's answer to an early-payment discount (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C4, C5). No session: the one-time link is the customer's only credential. Nothing from a failure reaches the customer
 * but a fixed sentence.
 */

export interface DiscountDecisionResult {
  ok: boolean;
  message: string;
  outcome?: "accepted" | "declined";
  /** Accepted: the receivable's pay link, where the customer pays the discounted amount; null when it cannot be shown. */
  payUrl?: string | null;
}

const NOT_VALID = "This link is no longer valid. Ask the business that sent it for a new one.";

export async function decideDiscountAction(_previous: DiscountDecisionResult, formData: FormData): Promise<DiscountDecisionResult> {
  const token = formData.get("token");
  const accept = formData.get("decision") === "accept";
  try {
    const decided = await decideDiscount(typeof token === "string" ? token : "", accept, { origin: siteOrigin() });
    if (decided.outcome === "accepted") {
      return {
        ok: true,
        outcome: "accepted",
        payUrl: decided.payUrl,
        message: decided.payUrl
          ? "Accepted. Pay the discounted amount through the invoice's pay link by the day shown."
          : "Accepted. Pay the discounted amount through the pay link the business sent you, by the day shown.",
      };
    }
    if (decided.outcome === "declined") return { ok: true, outcome: "declined", message: "No discount, then. The invoice stays as it was, due on its due date." };
    if (decided.outcome === "changed") return { ok: false, message: "This invoice changed since the offer was made, so nothing changed. Ask the business for a new offer." };
    return { ok: false, message: NOT_VALID };
  } catch {
    console.error("customer discount decision failed");
    return { ok: false, message: "That did not work. Try again in a moment." };
  }
}
