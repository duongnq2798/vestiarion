"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { CustomerOfferError, setCustomerOffers } from "@/lib/customer-offers/store";
import { inOrg } from "@/lib/dal/scope";

/**
 * The agent's early-payment discounts for customers turned on, with the most it gives, or off
 * (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md C1). Turning them on starts a cycle, so bills
 * already held for cash are weighed against what customers owe now.
 */

export interface CustomerOffersActionResult {
  ok: boolean;
  message: string;
}

export async function setCustomerOffersAction(_previous: CustomerOffersActionResult, formData: FormData): Promise<CustomerOffersActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const on = formData.get("on") === "true";
  const maxPct = on ? Number(String(formData.get("maxPct") ?? "").replace(",", ".").trim()) : null;
  return inOrg(auth, async () => {
    try {
      await setCustomerOffers({ orgId: auth.membership.orgId, actorId: auth.user.id, on, maxPct });
      revalidateOrgPages();
      if (on) raiseCycleEvent(auth, "customer_offers_on");
      return {
        ok: true,
        message: on ? "While bills are held for cash, the agent now offers customers a discount to pay early." : "The agent no longer offers customers discounts. Offers already out still stand.",
      };
    } catch (error) {
      if (error instanceof CustomerOfferError) return { ok: false, message: error.message };
      console.error("setCustomerOffersAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
