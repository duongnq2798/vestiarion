"use server";

import "server-only";

import { z } from "zod";
import { siteOrigin } from "@/lib/auth/env";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { createOffer, OfferError, setAgentOffers, withdrawOffer } from "@/lib/early-pay/offers";

/**
 * Early-payment offers from Bills & receivables (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E3,
 * E6): an owner or admin offers a supplier earlier payment for a discount, or withdraws the offer. The link is returned
 * once, to the person who made it, and never kept.
 */

export interface OfferActionResult {
  ok: boolean;
  message: string;
  /** The supplier's one-time link, shown once (E3). */
  url?: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const id = z.string().uuid();

export async function makeOfferAction(_previous: OfferActionResult, formData: FormData): Promise<OfferActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const invoiceId = id.safeParse(formData.get("invoiceId"));
    if (!invoiceId.success) return { ok: false, message: "That bill was not found." };
    const pct = Number(String(formData.get("pct") ?? "").replace(",", "."));
    try {
      const made = await createOffer({ orgId: auth.membership.orgId, actorId: auth.user.id, invoiceId: invoiceId.data, pct, origin: siteOrigin() });
      revalidateOrgPages();
      return { ok: true, message: "Offer made. Send the supplier this link: it works once.", url: made.url };
    } catch (error) {
      if (error instanceof OfferError) return { ok: false, message: error.message };
      console.error("makeOfferAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

export async function withdrawOfferAction(_previous: OfferActionResult, formData: FormData): Promise<OfferActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const offerId = id.safeParse(formData.get("offerId"));
    if (!offerId.success) return { ok: false, message: "That offer was not found." };
    try {
      const withdrawn = await withdrawOffer({ orgId: auth.membership.orgId, actorId: auth.user.id, offerId: offerId.data });
      revalidateOrgPages();
      return withdrawn ? { ok: true, message: "Offer withdrawn. The link no longer works." } : { ok: false, message: "That offer was already decided." };
    } catch (error) {
      console.error("withdrawOfferAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * The agent's own offers turned on, with the most it asks, or off (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md
 * AO1). Turning them on starts a cycle, so the bills already scheduled are weighed now.
 */
export async function setAgentOffersAction(_previous: OfferActionResult, formData: FormData): Promise<OfferActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const on = formData.get("on") === "true";
  const maxPct = on ? Number(String(formData.get("maxPct") ?? "").replace(",", ".")) : null;
  return inOrg(auth, async () => {
    try {
      await setAgentOffers({ orgId: auth.membership.orgId, actorId: auth.user.id, on, maxPct });
      revalidateOrgPages();
      if (on) raiseCycleEvent(auth, "early_offers_on");
      return { ok: true, message: on ? "The agent now offers these bills to their suppliers by email." : "The agent no longer makes offers. Offers already out still stand." };
    } catch (error) {
      if (error instanceof OfferError) return { ok: false, message: error.message };
      console.error("setAgentOffersAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
